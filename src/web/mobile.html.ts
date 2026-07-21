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

    /* Full-viewport canvas container. flex:1 so it absorbs everything
       below the slim topbar (no keyboard, no macros). */
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
  </style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="credsbtn" class="primary">Login</button>
    <button id="resizebtn">⤢ Resize</button>
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
  rfb.resizeSession = true;          // Match Xvnc -geometry 1024x768 client-side
  rfb.scaleViewport = true;          // CSS scale the canvas to fit #screen
  rfb.clipViewport = true;           // Don't draw outside #screen
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
  if (!rfb) return;
  // RFB owns its own canvas now (it lives inside rfb._screen which is
  // appended to our #screen div). Use its natural dimensions (set by RFB
  // to match the desktop) and CSS-scale to fit.
  const canvas = screen.querySelector('canvas');
  if (!canvas) return;
  const sw = screen.clientWidth, sh = screen.clientHeight;
  const cw = canvas.width, ch = canvas.height;
  if (!cw || !ch) return;
  const z = Math.min(sw / cw, sh / ch);
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = 'translate(-50%, -50%) scale(' + z + ')';
  canvas.style.position = 'absolute';
  canvas.style.left = '50%';
  canvas.style.top = '50%';
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

function sendKey(keysym) {
  if (!rfb) return;
  try { rfb.sendKey(keysym, true); rfb.sendKey(keysym, false); } catch (e) {}
}
function sendChar(ch) {
  var base = ch.toLowerCase();
  var keysym = XK[base] || XK[ch] || ch.charCodeAt(0);
  sendKey(keysym);
}

function pressKey(ch) {
  if (ch === 'shift') {
    shift = !shift;
    document.querySelectorAll('[data-key="shift"]').forEach((b) => {
      b.style.opacity = shift ? '1' : '0.6';
    });
    return;
  }
  if (ch === 'backspace') { sendKey(NAMED.BackSpace); shift = false; return; }
  if (ch === 'enter')    { sendKey(NAMED.enter);                return; }
  if (ch === 'space')    { sendKey(XK[' ']);                    return; }
  if (ch === '-')        { sendChar('-');                       return; }
  if (ch === '.')        { sendChar('.');                       return; }
  const out = shift ? ch.toUpperCase() : ch;
  sendChar(out);
  if (shift) {
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

// ── Resize button ───────────────────────────────────────────
// Calls fit() to recompute the CSS scale + translate so the VNC
// canvas fills the current #screen area. Also auto-runs on
// window resize / orientationchange so rotating the phone or
// showing/hiding the iOS keyboard re-flows the canvas without
// needing a manual press.
const resizebtn = document.getElementById('resizebtn');
resizebtn.addEventListener('click', () => {
  fit();
});
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);

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