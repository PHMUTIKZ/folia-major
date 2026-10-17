// electron/wallpaper/windowsWallpaperMouse.cjs
// Injects the Windows wallpaper helper's desktop mouse reports into the wallpaper renderer.
//
// The helper is per-monitor DPI aware and reports *physical* screen pixels (the virtual-screen
// space Windows uses natively); the injection API takes DIP coordinates relative to the window's
// content area. The conversion runs through Electron's own `screen.screenToDipPoint`, so both
// operands of the subtraction come from Chromium's mapping and a mixed-DPI desktop stays aligned.
// A DPI-unaware helper would instead report Windows' *virtualized* coordinates, which diverge from
// Electron's DIP space as soon as two monitors have different scale factors.
//
// Injection goes through `webContents.sendInputEvent` rather than posted window messages: Chromium
// arms TrackMouseEvent on the first processed WM_MOUSEMOVE, but the real cursor physically sits on
// the desktop icon layer above the wallpaper window, so the system instantly answers
// WM_MOUSELEAVE and hover is torn down between every forwarded move (measured 300–500 enter/leave
// pairs per second).

const WHEEL_DELTA = 120;
// Chromium's mouseWheel wants CSS pixels: ~100px per raw-input notch.
const WHEEL_PIXELS_PER_NOTCH = 100;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const DOUBLE_CLICK_SLOP_DIP = 8;

// The helper coalesces raw mouse moves onto a `MOUSE_MOVE_TIMER_MS` (16 ms) timer, which Windows
// quantizes to ~31 ms on a stock timer resolution: forwarding each report verbatim moves the
// wallpaper camera ~26 times a second no matter how fast the display refreshes, so on a 180 Hz
// panel five frames out of six repeat the previous picture and a drag reads as stepping. The pump
// below keeps the newest report and walks the remaining distance towards a velocity-extrapolated
// target in small steps, letting Chromium coalesce them onto compositor frames.
const MOVE_PUMP_INTERVAL_MS = 5;
const MOVE_PUMP_APPROACH = 0.55;
// A report is already up to one timer quantum old when it arrives; predicting that staleness away
// is what turns "the camera follows the cursor, late" into "the camera is on the cursor".
const MOVE_PUMP_LEAD_MS = 14;
const MOVE_PUMP_MAX_PREDICT_MS = 40;
const MOVE_PUMP_VELOCITY_DECAY = 0.8;
const MOVE_PUMP_VELOCITY_BLEND = 0.7;
const MOVE_PUMP_REST_SPEED = 0.02;

function createWindowsWallpaperMouseInjector(options = {}) {
  const {
    screen,
    getMainWindow,
    logWarn = console.warn.bind(console),
    interpolateMoves = false,
  } = options;

  // Tracks the primary button between helper mousedown/mouseup reports: injected mouseMove events
  // carry no button state of their own, and Chromium derives MouseEvent.buttons from the
  // 'leftbuttondown' modifier — without it a drag is torn down by the first forwarded move.
  let primaryButtonHeld = false;
  let lastPrimaryDown = { at: 0, x: 0, y: 0 };
  let dipConversionWarned = false;

  // Newest report, its smoothed velocity in DIP px per ms, and the position already injected.
  // All three are window-relative DIP, i.e. the same space `sendInputEvent` takes.
  let moveSample = null;
  let moveVelocity = { x: 0, y: 0 };
  let moveRendered = null;
  let movePumpTimer = null;
  let movePumpWindow = null;

  // Physical screen pixels → Chromium's DIP space. Falls back to the raw coordinates (the
  // pre-multi-monitor behaviour) when the platform conversion is unavailable, so mouse forwarding
  // degrades instead of stopping.
  function toDipPoint(x, y) {
    if (typeof screen.screenToDipPoint !== 'function') {
      if (!dipConversionWarned) {
        dipConversionWarned = true;
        logWarn('[WallpaperWin] screen.screenToDipPoint unavailable, assuming helper coordinates are DIP');
      }
      return { x, y };
    }
    try {
      const dip = screen.screenToDipPoint({ x, y });
      if (dip && Number.isFinite(dip.x) && Number.isFinite(dip.y)) {
        return dip;
      }
    } catch (error) {
      if (!dipConversionWarned) {
        dipConversionWarned = true;
        logWarn('[WallpaperWin] screen.screenToDipPoint failed, assuming helper coordinates are DIP', error && error.message);
      }
    }
    return { x, y };
  }

  function toWindowPoint(win, event) {
    const dip = toDipPoint(event.x, event.y);
    const bounds = win.getContentBounds();

    return {
      x: Math.round(dip.x - bounds.x),
      y: Math.round(dip.y - bounds.y),
      bounds,
    };
  }

  function injectMove(win, x, y) {
    const moveEvent = { type: 'mouseMove', x, y };
    if (primaryButtonHeld) {
      moveEvent.modifiers = ['leftbuttondown'];
    }
    win.webContents.sendInputEvent(moveEvent);
  }

  function stopMovePump() {
    if (movePumpTimer) {
      clearInterval(movePumpTimer);
      movePumpTimer = null;
    }
    movePumpWindow = null;
  }

  // Drops the drag's motion history. Called when the button goes down or up: a stale velocity from
  // the previous drag would otherwise extrapolate the next one's first frame in the old direction.
  function resetMovePump() {
    stopMovePump();
    moveSample = null;
    moveRendered = null;
    moveVelocity = { x: 0, y: 0 };
  }

  function recordMove(x, y) {
    const at = Date.now();
    if (moveSample) {
      const dt = Math.max(1, at - moveSample.at);
      moveVelocity = {
        x: moveVelocity.x * (1 - MOVE_PUMP_VELOCITY_BLEND) + ((x - moveSample.x) / dt) * MOVE_PUMP_VELOCITY_BLEND,
        y: moveVelocity.y * (1 - MOVE_PUMP_VELOCITY_BLEND) + ((y - moveSample.y) / dt) * MOVE_PUMP_VELOCITY_BLEND,
      };
    }
    moveSample = { x, y, at };
    if (!moveRendered) {
      moveRendered = { x, y };
    }
  }

  // Where the cursor should be now according to the newest report. The velocity bleeds while no
  // new report arrives, so a stop converges on the last real sample instead of coasting past it.
  function predictMove(now) {
    const idleMs = Math.max(0, now - moveSample.at);
    if (idleMs > 0) {
      moveVelocity = {
        x: moveVelocity.x * MOVE_PUMP_VELOCITY_DECAY,
        y: moveVelocity.y * MOVE_PUMP_VELOCITY_DECAY,
      };
    }
    const age = Math.min(idleMs + MOVE_PUMP_LEAD_MS, MOVE_PUMP_MAX_PREDICT_MS);
    return {
      x: moveSample.x + moveVelocity.x * age,
      y: moveSample.y + moveVelocity.y * age,
      settled: idleMs >= MOVE_PUMP_MAX_PREDICT_MS,
    };
  }

  function pumpMove() {
    const win = movePumpWindow;
    if (!win || win.isDestroyed() || !moveSample) {
      stopMovePump();
      return;
    }
    const target = predictMove(Date.now());
    const atRest =
      target.settled && Math.abs(moveVelocity.x) + Math.abs(moveVelocity.y) <= MOVE_PUMP_REST_SPEED;
    if (atRest) {
      // Land exactly on the last real sample; the prediction stops here rather than short of it.
      injectMove(win, moveSample.x, moveSample.y);
      stopMovePump();
      return;
    }
    moveRendered = {
      x: moveRendered.x + (target.x - moveRendered.x) * MOVE_PUMP_APPROACH,
      y: moveRendered.y + (target.y - moveRendered.y) * MOVE_PUMP_APPROACH,
    };
    injectMove(win, Math.round(moveRendered.x), Math.round(moveRendered.y));
  }

  function startMovePump(win) {
    movePumpWindow = win;
    if (movePumpTimer) {
      return;
    }
    movePumpTimer = setInterval(pumpMove, MOVE_PUMP_INTERVAL_MS);
    if (typeof movePumpTimer.unref === 'function') {
      movePumpTimer.unref();
    }
  }

  // One helper mouse event. Coordinates are physical screen pixels; they are converted to
  // window-relative DIP and injected at the Chromium input-pipeline level.
  function forward(event) {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed() || !event || typeof event.x !== 'number' || typeof event.y !== 'number') {
      return;
    }
    const { x, y, bounds } = toWindowPoint(win, event);
    // The wallpaper covers one monitor: anything on another monitor's desktop (or the taskbar) has
    // nothing to hover. Button-up is the exception — it is always delivered so a drag that leaves
    // the window cannot stick the pressed state.
    const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;

    switch (event.event) {
      case 'mousemove': {
        if (!inside) {
          return;
        }
        if (!interpolateMoves) {
          injectMove(win, x, y);
          return;
        }
        recordMove(x, y);
        startMovePump(win);
        return;
      }
      case 'mousedown': {
        if (!inside) {
          return;
        }
        resetMovePump();
        primaryButtonHeld = true;
        // clickCount must be synthesized: injected events bypass the OS multi-click detection.
        const now = Date.now();
        const isDoubleClick =
          now - lastPrimaryDown.at < DOUBLE_CLICK_INTERVAL_MS &&
          Math.abs(x - lastPrimaryDown.x) <= DOUBLE_CLICK_SLOP_DIP &&
          Math.abs(y - lastPrimaryDown.y) <= DOUBLE_CLICK_SLOP_DIP;
        lastPrimaryDown = { at: now, x, y };
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          x,
          y,
          button: 'left',
          clickCount: isDoubleClick ? 2 : 1,
          modifiers: ['leftbuttondown'],
        });
        return;
      }
      case 'mouseup': {
        resetMovePump();
        primaryButtonHeld = false;
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        return;
      }
      case 'mousewheel': {
        if (!inside) {
          return;
        }
        // Helper deltas are raw-input notches (multiples of WHEEL_DELTA=120; hi-res wheels send
        // smaller increments). The vertical sign passes through unchanged — sendInputEvent's
        // injected deltaY semantics are inverted relative to native wheel events (calibrated on
        // the real machine, where negating the raw delta produced reversed scrolling); horizontal
        // keeps its sign (positive = scroll right).
        const notch = (raw) => Math.round(((raw || 0) / WHEEL_DELTA) * WHEEL_PIXELS_PER_NOTCH);
        win.webContents.sendInputEvent({
          type: 'mouseWheel',
          x,
          y,
          deltaX: notch(event.deltaX),
          deltaY: notch(event.deltaY),
        });
        return;
      }
      default:
        return;
    }
  }

  return {
    forward,
  };
}

module.exports = {
  createWindowsWallpaperMouseInjector,
};
