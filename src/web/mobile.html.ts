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

    #topbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
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
      padding: 6px 10px; font-size: 13px;
      cursor: pointer;
    }
    #topbar button:active { background: #21262d; }

    #screen {
      flex: 1; min-height: 0;
      background: #000;
      position: relative;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-x pan-y;
    }
    #screen canvas { display: block; transform-origin: 0 0; }
    #placeholder {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 13px; text-align: center; padding: 24px;
      z-index: 5;
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
    .kbrow button:active { background: #21262d; }
    .kbrow button.wide { flex: 3; }
    .kbrow button.xwide { flex: 5; }
    .kbrow button.accent { background: var(--accent); color: #fff; border-color: var(--accent); }
    .kbrow button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
    .kbrow button.muted { color: var(--muted); }

    #macros {
      display: flex; gap: 4px; margin-bottom: 8px;
      flex-wrap: wrap;
    }
    #macros button {
      flex: 1; min-width: 70px;
      padding: 10px 8px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    #macros button:active { background: #21262d; }
  </style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="credsbtn">Credentials</button>
    <button id="reloadbtn">↻</button>
  </div>

  <div id="screen">
    <div id="placeholder">Loading KasmVNC RFB client…</div>
  </div>

  <div id="macros">
    <button data-macro="esc">Esc</button>
    <button data-macro="enter">Enter ⏎</button>
    <button data-macro="tab">Tab</button>
    <button data-macro="f2">F2 (Market Watch)</button>
    <button data-macro="ctrl-m">Ctrl+M</button>
    <button data-macro="ctrl-n">Ctrl+N (New Order)</button>
    <button data-macro="ctrl-w">Ctrl+W (close)</button>
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
      <button data-key="backspace" class="danger" style="flex: 1.5">⌫</button>
    </div>
    <div class="kbrow">
      <button data-key="-" class="muted">-</button>
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
  </form>
</div>

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');

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