/**
 * Mobile-friendly VNC wrapper for KasmVNC.
 *
 * Serves a single HTML page at /mobile that:
 *   1. Loads KasmVNC's bundled `core/rfb.js` (served same-origin at
 *      /vnc-static/core/rfb.js — copied from /usr/local/share/kasmvnc/www
 *      at build time). This is the same RFB class the KasmVNC web
 *      client uses; the difference is we instantiate it ourselves
 *      instead of going through the AngularJS admin UI (which has
 *      iframe-detection bugs).
 *   2. Renders MT5 into a full-viewport canvas with pinch/scroll.
 *   3. Provides a virtual QWERTY keyboard + macro buttons.
 *   4. Stores broker credentials in localStorage for one-tap fill.
 *
 * WebSocket URL: `ws://<host>:3000/` (KasmVNC's nginx forwards to
 * the Xvnc websockify backend at :6901). The path '/websockify'
 * does NOT work — KasmVNC serves the WebSocket at the root '/'.
 */

export const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0e14" />
  <title>akroncloud-slot · mobile VNC</title>
  <style>
    :root {
      --bg: #0b0e14;
      --panel: #161b22;
      --border: #30363d;
      --fg: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --danger: #f85149;
      --ok: #3fb950;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: var(--bg); color: var(--fg);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overscroll-behavior: none;
      -webkit-tap-highlight-color: transparent;
    }
    #app { display: flex; flex-direction: column; height: 100dvh; height: 100vh; }

    /* Slim topbar: dot + label + 3 icon-sized buttons.
       Goal: maximize screen area for the VNC canvas. */
    #topbar {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      font-size: 12px;
    }
    #topbar .status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--muted);
      flex-shrink: 0;
    }
    #topbar .status.ok { background: var(--ok); }
    #topbar .status.err { background: var(--danger); }
    #topbar .label {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-size: 12px; color: var(--muted);
    }
    #topbar button {
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 8px; font-size: 12px;
      cursor: pointer;
      min-width: 32px;
      min-height: 32px;
    }
    #topbar button:active { background: #21262d; }
    #topbar button.primary {
      background: var(--accent); color: #fff; border-color: var(--accent);
    }
    #topbar button.primary:disabled { opacity: .5; }

    /* Full-viewport canvas container. The canvas inside is
       position:absolute + transform-centered via JS (see
       applyCanvasCentering), not via CSS - RFB's inline display:flex
       + margin:auto on the canvas beat author CSS !important rules. */
    #screen {
      flex: 1; min-height: 0;
      background: #000;
      position: relative;
      overflow: hidden;
      touch-action: none;
    }
    #screen canvas { display: block; transform-origin: 0 0; }
    #placeholder {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 13px; text-align: center; padding: 24px;
      z-index: 5;
      pointer-events: none;
    }

    #credsheet {
      position: fixed; inset: 0; background: rgba(0,0,0,.7);
      display: none; align-items: center; justify-content: center;
      z-index: 100; padding: 16px;
    }
    #credsheet.open { display: flex; }
    #credsheet form {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px; width: 100%; max-width: 420px;
    }
    #credsheet h2 { margin: 0 0 12px; font-size: 16px; }
    #credsheet label {
      display: block; font-size: 12px; color: var(--muted);
      margin: 8px 0 4px;
    }
    #credsheet input {
      width: 100%; padding: 10px 12px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px;
      font-size: 16px;
    }
    #credsheet .row { display: flex; gap: 8px; margin-top: 16px; }
    #credsheet button {
      flex: 1; padding: 12px; font-size: 15px; font-weight: 500;
      background: var(--accent); color: #fff; border: 0;
      border-radius: 6px; cursor: pointer;
    }
    #credsheet button.ghost {
      background: transparent; color: var(--fg);
      border: 1px solid var(--border);
    }

    #keyboard {
      flex-shrink: 0;
      background: var(--panel);
      border-top: 1px solid var(--border);
      padding: 8px 6px 12px;
      touch-action: manipulation;
      user-select: none;
    }
    .kbrow { display: flex; gap: 4px; margin-bottom: 4px; }
    .kbrow button {
      flex: 1; min-width: 0;
      padding: 14px 4px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 16px;
      font-family: ui-monospace, "SF Mono", monospace;
      cursor: pointer;
      touch-action: manipulation;
    }
    .kbrow button.muted { color: var(--muted); }

    /* Compact keyboard (4 rows) + safe-area bottom padding so the home
       indicator of an iPhone notch doesn't overlap the last row.
       min-height tightened from 28 -> 24px (saves ~16px). */
    #keyboard {
      flex-shrink: 0;
      background: var(--panel);
      border-top: 1px solid var(--border);
      padding: 4px 4px max(6px, env(safe-area-inset-bottom));
      touch-action: manipulation;
      user-select: none;
    }
    #topbar {
      padding-top: max(4px, env(safe-area-inset-top));
    }
    .kbrow { display: flex; gap: 3px; margin-bottom: 3px; }
    .kbrow button {
      flex: 1; min-width: 0;
      padding: 4px 2px;
      min-height: 24px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", monospace;
      cursor: pointer;
      touch-action: manipulation;
    }
    .kbrow button:active { background: #21262d; }
    .kbrow button.wide { flex: 3; }
    .kbrow button.xwide { flex: 6; }
    .kbrow button.accent { background: var(--accent); color: #fff; border-color: var(--accent); }
    .kbrow button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
    .kbrow button.muted { color: var(--muted); }
    /* When sticky shift is active, render the letter keys as
       uppercase so the user has visual feedback. The toggle is
       applied to the whole #keyboard container via a class
       set in JS, which keeps the change cheap (one DOM write
       per shift toggle). */
    #keyboard.shift-on .kbrow button {
      text-transform: uppercase;
    }
  </style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="credsbtn" class="primary">Login</button>
    <button id="resetbtn" title="Clear the currently-focused MT5 input field (Ctrl+A then Delete). Use after a wrong-credential entry.">Reset</button>
    <button id="syncbtn" disabled>Sync</button>
    <button id="reloadbtn">↻</button>
  </div>

  <div id="screen">
    <div id="placeholder">Loading KasmVNC RFB client…</div>
  </div>

  <div id="keyboard">
    <div class="kbrow">
      <button data-key="q">q</button>
      <button data-key="w">w</button>
      <button data-key="e">e</button>
      <button data-key="r">r</button>
      <button data-key="t">t</button>
      <button data-key="y">y</button>
      <button data-key="u">u</button>
      <button data-key="i">i</button>
      <button data-key="o">o</button>
      <button data-key="p">p</button>
    </div>
    <div class="kbrow">
      <button data-key="a">a</button>
      <button data-key="s">s</button>
      <button data-key="d">d</button>
      <button data-key="f">f</button>
      <button data-key="g">g</button>
      <button data-key="h">h</button>
      <button data-key="j">j</button>
      <button data-key="k">k</button>
      <button data-key="l">l</button>
      <button data-key="backspace" class="danger">⌫</button>
    </div>
    <div class="kbrow">
      <button data-key="shift" class="accent" style="flex: 1.5">⇧</button>
      <button data-key="z">z</button>
      <button data-key="x">x</button>
      <button data-key="c">c</button>
      <button data-key="v">v</button>
      <button data-key="b">b</button>
      <button data-key="n">n</button>
      <button data-key="m">m</button>
      <button data-key="." class="muted">.</button>
      <button data-key="-" class="muted">-</button>
    </div>
    <div class="kbrow">
      <button data-key="1">1</button>
      <button data-key="2">2</button>
      <button data-key="3">3</button>
      <button data-key="4">4</button>
      <button data-key="5">5</button>
      <button data-key="6">6</button>
      <button data-key="7">7</button>
      <button data-key="8">8</button>
      <button data-key="9">9</button>
      <button data-key="0">0</button>
    </div>

    <div class="kbrow">
      <button data-key="space" class="xwide muted">space</button>
      <button data-key="enter" class="accent wide">enter ⏎</button>
    </div>
  </div>
</div>

<div id="credsheet">
  <form id="credform">
    <h2>Broker credentials</h2>
    <p style="color: var(--muted); margin: 0 0 8px; font-size: 13px;">
      Stored in this browser only. Used to auto-fill the MT5 login form.
    </p>
    <label>Server</label>
    <input id="f_server" autocomplete="off" autocapitalize="characters" />
    <label>Login (account number)</label>
    <input id="f_login" autocomplete="off" inputmode="numeric" />
    <label>Password</label>
    <input id="f_password" type="password" autocomplete="off" />
    <label>Investor password (optional)</label>
    <input id="f_investor" type="password" autocomplete="off" />
    <div class="row">
      <button type="button" class="ghost" id="credcancel">Cancel</button>
      <button type="button" class="ghost" id="credfill">Fill</button>
      <button type="submit">Save &amp; Fill</button>
    </div>
    <hr style="border: 0; border-top: 1px solid var(--border); margin: 16px 0 8px;">
    <h2 style="font-size: 14px; margin-top: 0;">Custom text</h2>
    <p style="color: var(--muted); margin: 0 0 8px; font-size: 12px;">
      Types into whatever MT5 field is currently focused. Useful for
      one-off strings (server URLs, account notes, ad-hoc login
      fixes). Characters are sent one at a time at 30ms each.
    </p>
    <textarea id="f_custom" rows="3" placeholder="e.g. Demo-Deriv-01 or a long server name"
      style="font-family: ui-monospace, monospace; font-size: 13px; resize: vertical;"></textarea>
    <div class="row">
      <button type="button" class="ghost" id="credtypecustom">Type custom</button>
      <button type="button" class="ghost" id="credresetmt5">Reset MT5 input</button>
      <button type="button" class="ghost" id="credclearstored">Clear saved</button>
    </div>
  </form>
</div>

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');
const { default: MouseButtonMapper } = await import('/vnc-static/core/mousebuttonmapper.js');

// Bundle-without-UI shims applied at the PROTOTYPE level (not the
// instance) so they take effect for every RFB we ever instantiate,
// regardless of timing. Two earlier attempts at per-instance shims
// in v23/v24 were silently no-op because:
//   - v23 added addEventListener('init', ...) but the fork never
//     fires 'init' (no CustomEvent('init') anywhere in rfb.js).
//   - v24/v25 added them to 'connect', which DOES fire - but the
//     user kept seeing the errors, so something was racing the
//     listener (cache, connect firing twice, etc.). Patching the
//     prototype makes the fix unconditional.
const _origHandleSubscribeUnixRelay = RFB.prototype._handleSubscribeUnixRelay;
RFB.prototype._handleSubscribeUnixRelay = function () {
  // Same drain semantics as _rQwait/_rQshiftStr so the message
  // dispatcher stays in sync. We simply discard the payload.
  if (!this._sock) return false;
  // 2-byte header: status (1) + len (1)
  if (this._sock.rQwait('UnixRelaySub header', 2, 1)) return false;
  const status = this._sock.rQshift8();
  const len = this._sock.rQshift8();
  if (this._sock.rQwait('UnixRelaySub payload', len, 3)) return false;
  this._sock.rQshiftStr(len);
  // Returning false tells _normalMsg we're done with this message.
  return false;
};
// Save the original _handleSubscribeUnixRelay for any caller that
// wants to invoke it explicitly (none today, but useful for tests).
RFB.prototype._origHandleSubscribeUnixRelay = _origHandleSubscribeUnixRelay;

const _origHandleMouse = RFB.prototype._handleMouse;
RFB.prototype._handleMouse = function (ev) {
  // The bundled fork inits this.mouseButtonMapper to null and
  // expects app/ui.js to assign it later. We don't use ui.js, so
  // lazy-init a default mapper on the first mouse event. With
  // this guard, every subsequent call has a populated mapper and
  // never sees the "Cannot read property get of null" TypeError.
  if (!this.mouseButtonMapper) {
    const m = new MouseButtonMapper();
    m.set(0, 1); m.set(1, 2); m.set(2, 3); m.set(3, 8); m.set(4, 9);
    this.mouseButtonMapper = m;
  }
  return _origHandleMouse.call(this, ev);
};

const statusDot   = document.getElementById('status');
const statusLabel = document.getElementById('statuslabel');
const screen      = document.getElementById('screen');
const placeholder = document.getElementById('placeholder');
const credsheet   = document.getElementById('credsheet');
const credbtn     = document.getElementById('credsbtn');
const reloadbtn   = document.getElementById('reloadbtn');

const host = location.host;
// location.host includes the port when it's non-default
// (e.g. "45.151.122.104:7777"). Using location.hostname here would
// drop the port and the browser would dial the WS default port
// (80 / 443), which the slot does NOT listen on -> silent WS
// failure with code 1006. This bug was hidden until we fixed the
// RFB-constructor crash: before that, mobile.js never got far
// enough to open the socket.
// Same-origin WebSocket proxy in the slot (see mt5-ws-proxy.ts)
// which pipes bytes to KasmVNC's :3000/websockify. Going to
// :7777 keeps the WS upgrade inside the slot's port and avoids
// firewall / port-isolation issues on mobile carriers.
const wsUrl = 'wss://' + host + '/mt5-ws';
// For local dev / non-TLS testing, also try ws:// (most browsers
// will auto-upgrade ws:// on the same host).
const wsUrlFallback = 'ws://' + host + '/mt5-ws';

let shift = false;
const creds = loadCreds();
let rfb = null;

function setStatus(state, msg) {
  statusDot.className = 'status' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  statusLabel.textContent = msg;
}

function connect() {
  setStatus('', 'connecting to ' + wsUrl + '…');
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Connecting to KasmVNC…';

  // RFB creates its own canvas and wrapper <div> internally; we just give
  // it a container to attach them to. (Earlier we passed a manually-created
  // canvas as the target, but RFB's connect path does target.appendChild
  // with an internal wrapper div, which throws DOMException on a <canvas>
  // element - the browser kills the WS within a couple of seconds and we
  // never see a frame. Passing #screen lets the structure go where RFB
  // expects it.)
  screen.innerHTML = '';

  // KasmVNC fork of RFB has signature:
  //   constructor(target, touchInput, urlOrChannel, options, isPrimaryDisplay)
  // The URL must be the 3rd positional arg, not the 2nd. Passing the URL
  // as touchInput caused Keyboard._keyboardInputReset to assign .value on
  // the string and crash with:
  //   TypeError: Cannot create property value on string ws://45.151.122.104/mt5-ws
  // We pass null for touchInput (the wrapper has its own creds modal that
  // types via rfb.sendKey; no IME on the MT5 canvas itself).
  // 5th positional arg: isPrimaryDisplay = true (was implicit; explicit for clarity).
  rfb = new RFB(screen, null, wsUrlFallback, {
    background: '#000',
  }, true);

  // Apply KasmVNC defaults that match the bundled UI. resizeSession,
  // clipViewport, qualityLevel, etc. are not read from the options
  // object - they're properties set after construction.
  //
  // For the mobile wrapper we lock the desktop to a portrait
  // phone-friendly size. Earlier we used resizeSession=true which
  // made RFB send SetDesktopSize on every window resize event
  // (rotation, iOS keyboard, viewport resize). Each user with a
  // different sized browser ended up leaving Xvnc resized to a
  // weird in-between value (603x885, 1920x920, etc.) which made
  // the MT5 chart tiny in the live phone.
  //
  // We now:
  //   - disable resizeSession so the server DOES NOT renegotiate
  //     on viewport changes (the slot stays at one stable size)
  //   - force the desktop to 414x896 (portrait iPhone), which
  //     RFB negotiates once on init via _requestRemoteResize
  //   - keep scaleViewport+clipViewport so the client scales the
  //     fixed 414x896 canvas down to fit the phone viewport, with
  //     letterbox centering via the flex container.
  rfb.resizeSession = false;
  // We pick 414x500 (portrait iPhone width, shorter height) instead
  // of the Xvnc cmdline 1024x768 or a full 414x896. The shorter
  // height means the chart window in the visible canvas is bigger
  // relative to the phone viewport - autoscale fits the desktop
  // to the phone width (no horizontal letterbox) while keeping the
  // chart at a comfortable aspect. The previous 414x896 was
  // correct in count of pixels but made the visible chart look
  // small on the phone because the empty MT5 desktop below
  // the chart window ate half the canvas.
  rfb.forcedResolutionX = 414;
  rfb.forcedResolutionY = 500;
  rfb.scaleViewport = true;
  rfb.clipViewport = true;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.addEventListener('connect', () => {
    setStatus('ok', 'connected to MT5');
    placeholder.style.display = 'none';
    fit();
    // Auto-sync once on connect. SlotService.mq5 will emit an
    // account_status event shortly after the MT5 desktop is up; this
    // POST nudges the slot to re-validate even before that event
    // arrives, so /v1/accounts reflects the live session quickly.
    // It is a no-op if the connector is not running.
    enableSyncButton();
    triggerSync('auto');
    // mouseButtonMapper init and _handleSubscribeUnixRelay shim run
    // at the prototype level (top of this <script>). Do NOT redo
    // them here - they already apply for every RFB instance.
  });
  rfb.addEventListener('disconnect', (e) => {
    const why = e && e.detail && e.detail.reason ? ': ' + e.detail.reason : '';
    setStatus('err', 'disconnected' + why);
    placeholder.style.display = 'flex';
    placeholder.textContent = 'Disconnected. Tap ↻ to retry.';
  });
  rfb.addEventListener('credentialsrequired', () => {
    setStatus('', 'credentials required (server-side)');
  });
}

function fit() {
  // What this does:
  //   1. Recompute the canvas pixel-fit against the current #screen
  //      size via Display.autoscale (RFB owns the canvas style.width
  //      / style.height). This is what the bundled UI does on window
  //      'resize'.
  //   2. Re-request a full (non-incremental) framebuffer update from
  //      KasmVNC so any stale pixels get redrawn. Without this, RFB
  //      won't ask for new pixels unless the server pushes them, and
  //      some state (e.g. recovering from a 'disconnected' that
  //      re-connected with gaps) can stay stale visually.
  //   3. Briefly flip the topbar label so the user gets explicit
  //      feedback that the click did something. On a perfectly-fitted
  //      canvas #1 above produces the same final result as before,
  //      so the click would otherwise feel dead.
  //   4. Re-apply our JS-level canvas centering. CSS !important with
  //      RFB's inline margin:auto had been getting in a CSS
  //      specificity war. Setting the inline style after RFB finished
  //      its own setup is robust and bulletproof.
  if (!rfb) return;
  setStatus('ok', 'refitting + refreshing framebuffer…');
  try { rfb._updateScale(); } catch (e) { /* defensive */ }
  try {
    RFB.messages.fbUpdateRequest(rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
  } catch (e) { /* defensive */ }
  applyCanvasCentering();
  setTimeout(() => setStatus('ok', 'refreshed (' + (rfb._fbWidth || 0) + 'x' + (rfb._fbHeight || 0) + ')'), 350);
}

// Force the canvas to be centered inside RFB's wrapper <div>. RFB
// inlines display:flex + margin:auto on the canvas, which wins
// over our flex/justify-content author CSS via inline style
// specificity. Setting the inline style here (after RFB has run
// its constructor and connected) is the only thing that reliably
// works. Called once on connect (via fit() in the connect
// listener) and any time fit() runs.
function applyCanvasCentering() {
  const rfbScreen = screen.querySelector('div');
  if (rfbScreen) {
    rfbScreen.style.position = 'relative';
    rfbScreen.style.width = '100%';
    rfbScreen.style.height = '100%';
    rfbScreen.style.display = 'block';
  }
  const canvas = screen.querySelector('canvas');
  if (canvas) {
    canvas.style.position = 'absolute';
    canvas.style.top = '50%';
    canvas.style.left = '50%';
    canvas.style.margin = '0';
    canvas.style.transform = 'translate(-50%, -50%)';
  }
}

const XK = {
  ' ': 0x20, '!': 0x21, '"': 0x22, '#': 0x23, '$': 0x24, '%': 0x25,
  '&': 0x26, "'": 0x27, '(': 0x28, ')': 0x29, '*': 0x2A, '+': 0x2B,
  ',': 0x2C, '-': 0x2D, '.': 0x2E, '/': 0x2F,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  ':': 0x3A, ';': 0x3B, '<': 0x3C, '=': 0x3D, '>': 0x3E, '?': 0x3F,
  '@': 0x40,
  'a': 0x61, 'b': 0x62, 'c': 0x63, 'd': 0x64, 'e': 0x65, 'f': 0x66,
  'g': 0x67, 'h': 0x68, 'i': 0x69, 'j': 0x6A, 'k': 0x6B, 'l': 0x6C,
  'm': 0x6D, 'n': 0x6E, 'o': 0x6F, 'p': 0x70, 'q': 0x71, 'r': 0x72,
  's': 0x73, 't': 0x74, 'u': 0x75, 'v': 0x76, 'w': 0x77, 'x': 0x78,
  'y': 0x79, 'z': 0x7A,
};
const NAMED = {
  'esc': 0xFF1B, 'tab': 0xFF09, 'enter': 0xFF0D, 'f2': 0xFFBE,
  'BackSpace': 0xFF08, 'shift_L': 0xFFE1, 'Control_L': 0xFFE3,
};

function sendKeyDown(keysym, code) {
  if (!rfb) return;
  try { rfb.sendKey(keysym, code || null, true); } catch (e) {}
}
function sendKeyUp(keysym, code) {
  if (!rfb) return;
  try { rfb.sendKey(keysym, code || null, false); } catch (e) {}
}
function sendKey(keysym, code) {
  // Convenience: tap (down + up). The two halves above are what
  // pressKey uses for proper modifier handling (Shift down before
  // the letter, Shift up after).
  sendKeyDown(keysym, code);
  sendKeyUp(keysym, code);
}
function sendChar(ch) {
  // Always go through the scancode path so the X server XKB layer
  // resolves the key correctly. RFB code arg is the HTML
  // KeyboardEvent.code string; with it, RFB looks up the scancode
  // in XtScancode and sends a QEMU Extended Key Event. Without
  // it, RFB falls back to a plain KeyEvent (keysym only) which
  // some KasmVNC versions process incorrectly.
  var base = ch.toLowerCase();
  var keysym = XK[base] || XK[ch] || ch.charCodeAt(0);
  var code = charToCode(ch);
  sendKey(keysym, code);
}

// Map a printable character to its KeyboardEvent.code string. We
// use this in every send so the QEMU Extended Key Event path is
// used uniformly for both the modifier (Shift) and the letter.
function charToCode(ch) {
  if (/^[a-z]$/i.test(ch)) return 'Key' + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
  if (ch === ' ') return 'Space';
  if (ch === '-') return 'Minus';
  if (ch === '.') return 'Period';
  if (ch === ',') return 'Comma';
  if (ch === '/') return 'Slash';
  return null;  // let sendKey try without code
}

function pressKey(ch) {
  if (ch === 'shift') {
    // Sticky shift: tap the key once, next letter is uppercase,
    // then the shift state auto-clears. We pass 'ShiftLeft' as
    // the KeyboardEvent.code so RFB looks up the scancode (0x2A
    // per XtScancode) and sends a QEMU Extended Key Event - the
    // scancode path is what KasmVNC actually translates into a
    // real Shift modifier; keysym-only often gets silently
    // swallowed by the X server.
    shift = !shift;
    // Visual feedback: the keyboard container gets a class
    // that uppercases the letter buttons via CSS. One DOM write
    // per shift toggle. Numbers and symbols are unaffected by
    // text-transform:uppercase.
    const kbd = document.getElementById('keyboard');
    if (kbd) kbd.classList.toggle('shift-on', shift);
    document.querySelectorAll('[data-key="shift"]').forEach((b) => {
      b.style.opacity = shift ? '1' : '0.6';
    });
    sendKey(NAMED.shift_L, 'ShiftLeft');
    return;
  }
  // When shift is sticky, hold Shift down BEFORE the key and
  // release AFTER. Send the scancode path for Shift so the
  // modifier actually takes effect on the X server side.
  var wasShifted = shift;
  if (wasShifted) {
    sendKeyDown(NAMED.shift_L, 'ShiftLeft');
    // Small wait so the X server processes the Shift down before
    // the letter press. RFB queues WS messages and the server
    // processes them in order, but some KasmVNC versions coalesce
    // or drop modifier events that arrive in the same tick as the
    // letter. A 5ms gap avoids the race.
    const t0 = performance.now();
    while (performance.now() - t0 < 5) {}
  }

  // Use the scancode path uniformly for every key, including
  // backspace / enter / space / letters / digits / symbols. The
  // previous version sent those with code=null, which falls back
  // to a plain KeyEvent - on KasmVNC that's a less reliable path
  // than QEMU Extended Key Event.
  var code = null;
  if (ch === 'backspace') code = 'Backspace';
  else if (ch === 'enter')    code = 'Enter';
  else if (ch === 'space')    code = 'Space';
  else                          code = charToCode(ch);

  if (ch === 'backspace') { sendKey(NAMED.BackSpace, code); }
  else if (ch === 'enter')    { sendKey(NAMED.enter, code); }
  else if (ch === 'space')    { sendKey(XK[' '], code); }
  else if (ch === '-')        { sendChar('-'); }
  else if (ch === '.')        { sendChar('.'); }
  else                        { sendChar(wasShifted ? ch.toUpperCase() : ch); }

  if (wasShifted) {
    sendKeyUp(NAMED.shift_L, 'ShiftLeft');
    shift = false;
    document.querySelectorAll('[data-key="shift"]').forEach((b) => {
      b.style.opacity = '0.6';
    });
  }
}

function sendMacro(macro) {
  if (macro === 'esc' || macro === 'tab' || macro === 'enter' || macro === 'f2') {
    sendKey(NAMED[macro]);
    return;
  }
  if (macro.indexOf('ctrl-') === 0) {
    const key = macro.slice(5);
    sendKey(NAMED.Control_L);
    sendKey(XK[key.toLowerCase()] || XK[key] || key.toUpperCase().charCodeAt(0));
    sendKey(NAMED.Control_L);
    return;
  }
}

function loadCreds() {
  try { return JSON.parse(localStorage.getItem('akron.creds.v1') || '{}'); }
  catch (e) { return {}; }
}
function saveCreds() { localStorage.setItem('akron.creds.v1', JSON.stringify(creds)); }
function openCreds() {
  document.getElementById('f_server').value    = creds.server    || '';
  document.getElementById('f_login').value     = creds.login     || '';
  document.getElementById('f_password').value  = creds.password  || '';
  document.getElementById('f_investor').value  = creds.investor  || '';
  credsheet.classList.add('open');
}
function closeCreds() { credsheet.classList.remove('open'); }

function fillFromCreds() {
  if (!rfb) { setStatus('err', 'rfb not ready'); return; }
  const fields = [
    { value: creds.server,   allowShift: true },
    { value: creds.login,    allowShift: true },
    { value: creds.password, allowShift: true },
  ];
  if (creds.investor) fields.push({ value: creds.investor, allowShift: true });
  let i = 0;
  function next() {
    if (i >= fields.length) {
      setTimeout(() => sendKey(NAMED.enter), 200);
      return;
    }
    const f = fields[i++];
    if (!f.value) { next(); return; }
    typeString(f.value, () => {
      if (i < fields.length) {
        setTimeout(() => { sendKey(NAMED.tab); next(); }, 150);
      } else {
        next();
      }
    });
  }
  function typeString(s, done) {
    const chars = s.split('');
    let j = 0;
    function tick() {
      if (j >= chars.length) { done(); return; }
      const c = chars[j++];
      if (/[A-Z]/.test(c)) {
        sendKey(NAMED.shift_L);
      }
      setTimeout(() => { pressKey(c.toLowerCase()); tick(); }, 35);
    }
    tick();
  }
  next();
}

document.querySelectorAll('[data-key]').forEach((b) => {
  b.addEventListener('click', () => pressKey(b.dataset.key));
});
document.querySelectorAll('[data-macro]').forEach((b) => {
  b.addEventListener('click', () => sendMacro(b.dataset.macro));
});
credbtn.addEventListener('click', openCreds);
document.getElementById('credcancel').addEventListener('click', closeCreds);
document.getElementById('credfill').addEventListener('click', () => {
  closeCreds();
  fillFromCreds();
});
// Topbar Reset = sends Ctrl+A then Delete into the currently-focused
// MT5 input field. Same effect as the modal's "Reset MT5 input" but
// reachable in 1 click without opening the modal.
document.getElementById('resetbtn').addEventListener('click', () => {
  if (!rfb) { setStatus('err', 'rfb not ready'); return; }
  setStatus('ok', 'clearing focused MT5 field…');
  sendKeyDown(NAMED.Control_L);
  sendKeyDown(0x61); // XK_a
  sendKeyUp(0x61);
  sendKeyUp(NAMED.Control_L);
  sendKeyDown(0xFFFF); // XK_Delete
  sendKeyUp(0xFFFF);
  setStatus('ok', 'focused MT5 field cleared');
});

// ── Custom text + recovery (no creds match / type-again) ────
// Type whatever's in the #f_custom textarea into whatever MT5
// field is currently focused. Each char at 30ms, like fillFromCreds.
function typeCustomToMT5() {
  if (!rfb) { setStatus('err', 'rfb not ready'); return; }
  const text = document.getElementById('f_custom').value || '';
  if (!text) { setStatus('err', 'custom text is empty'); return; }
  closeCreds();
  setStatus('ok', 'typing custom into MT5…');
  let i = 0;
  function tick() {
    if (i >= text.length) { setStatus('ok', 'typed custom (' + text.length + ' chars)'); return; }
    pressKey(text[i]);
    i++;
    setTimeout(tick, 30);
  }
  tick();
}

// Select-all + Delete in the currently-focused MT5 field. Useful
// when the broker login errored and the user wants to retype -
// they click the field, click this, and the field is empty.
function resetMT5Input() {
  if (!rfb) { setStatus('err', 'rfb not ready'); return; }
  closeCreds();
  setStatus('ok', 'clearing focused MT5 field…');
  // Ctrl + A (select all), then Delete.
  sendKeyDown(NAMED.Control_L);
  sendKeyDown(0x61); // XK_a
  sendKeyUp(0x61);
  sendKeyUp(NAMED.Control_L);
  sendKeyDown(0xFFFF); // XK_Delete
  sendKeyUp(0xFFFF);
  setStatus('ok', 'focused MT5 field cleared');
}

// Wipe stored creds and the modal's inputs. Useful if the user
// made a typo in the modal and wants to start over without
// closing the browser.
function clearStoredCreds() {
  try { localStorage.removeItem('akron.creds.v1'); } catch (e) {}
  creds = {};
  document.getElementById('f_server').value = '';
  document.getElementById('f_login').value = '';
  document.getElementById('f_password').value = '';
  document.getElementById('f_investor').value = '';
  document.getElementById('f_custom').value = '';
  setStatus('ok', 'cleared saved creds + modal inputs');
}
document.getElementById('credtypecustom').addEventListener('click', typeCustomToMT5);
document.getElementById('credresetmt5').addEventListener('click', resetMT5Input);
document.getElementById('credclearstored').addEventListener('click', clearStoredCreds);

// ── Sync button ──────────────────────────────────────────────
// /internal/sync is a same-origin, no-JWT endpoint that re-validates
// every active account via the slot connector (see src/api/internal.ts).
// It is safe to call repeatedly - the slot de-duplicates in-process.
const syncbtn = document.getElementById('syncbtn');
function enableSyncButton() {
  syncbtn.disabled = false;
  syncbtn.textContent = 'Sync';
  syncbtn.onclick = () => triggerSync('manual');
}
async function triggerSync(reason) {
  syncbtn.disabled = true;
  syncbtn.textContent = 'Syncing…';
  try {
    const r = await fetch('/internal/sync', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    const n = (body && body.accounts) ? body.accounts.length : 0;
    setStatus('ok', 'synced ' + n + ' acct' + (n === 1 ? '' : 's') + ' (' + reason + ')');
    setTimeout(() => { syncbtn.disabled = false; syncbtn.textContent = 'Sync'; }, 1200);
  } catch (err) {
    setStatus('err', 'sync failed: ' + (err && err.message || err));
    syncbtn.disabled = false;
    syncbtn.textContent = 'Sync';
  }
}
document.getElementById('credform').addEventListener('submit', (e) => {
  e.preventDefault();
  creds = {
    server:   document.getElementById('f_server').value,
    login:    document.getElementById('f_login').value,
    password: document.getElementById('f_password').value,
    investor: document.getElementById('f_investor').value,
  };
  saveCreds();
  closeCreds();
  fillFromCreds();
});
reloadbtn.addEventListener('click', () => {
  if (rfb) { try { rfb.disconnect(); } catch(e) {} }
  setTimeout(connect, 200);
});

connect();
</script>
</body>
</html>`;