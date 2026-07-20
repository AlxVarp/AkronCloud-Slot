/**
 * Mobile-friendly VNC wrapper for KasmVNC.
 *
 * Serves a single HTML page at /mobile that:
 *   1. Connects to KasmVNC's WebSocket bridge (ws://host:3000/websockify)
 *      using the noVNC RFB client (loaded from a CDN).
 *   2. Renders the MT5 desktop in a full-viewport canvas.
 *   3. Provides a virtual keyboard + macro buttons for phone users.
 *   4. Stores broker credentials in localStorage for one-tap fill.
 *
 * The HTML is inlined to keep this single-file (no static file serving
 * required). Keep it lean — the page runs on a phone browser.
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

    /* ─── top bar ─── */
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

    /* ─── VNC canvas ─── */
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
    }

    /* ─── credential sheet ─── */
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

    /* ─── keyboard ─── */
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

    #zoom {
      position: absolute; top: 8px; right: 8px;
      display: flex; flex-direction: column; gap: 4px;
      z-index: 5;
    }
    #zoom button {
      width: 40px; height: 40px;
      background: rgba(0,0,0,.6); color: #fff;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 6px;
      font-size: 18px;
      cursor: pointer;
    }
  </style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="credsbtn">Credentials</button>
    <button id="fitbtn">Fit</button>
    <button id="reloadbtn">↻</button>
  </div>

  <div id="screen">
    <div id="zoom">
      <button data-zoom="in" title="Zoom in">+</button>
      <button data-zoom="out" title="Zoom out">−</button>
      <button data-zoom="1" title="Reset">1×</button>
    </div>
    <div id="placeholder">Connecting to KasmVNC…</div>
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
    <div class="kbrow" id="row1">
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
    <div class="kbrow" id="row2">
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
    <div class="kbrow" id="row3">
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
    <div class="kbrow" id="row4">
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
    <div class="kbrow" id="row5">
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

<script>
(function () {
  'use strict';

  var NO_VNC_URL = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js';

  var statusDot   = document.getElementById('status');
  var statusLabel = document.getElementById('statuslabel');
  var screen      = document.getElementById('screen');
  var placeholder = document.getElementById('placeholder');
  var credsheet   = document.getElementById('credsheet');
  var credbtn     = document.getElementById('credsbtn');
  var reloadbtn   = document.getElementById('reloadbtn');
  var fitbtn      = document.getElementById('fitbtn');

  var rfb = null;
  var shift = false;
  var zoom = 1;
  var creds = loadCreds();

  var host = location.hostname;
  // KasmVNC's Xvnc WebSocket lives at the nginx root path / on
  // port 3000 (forwarded by nginx from KasmVNC's own :6901). The
  // legacy /websockify alias is NOT registered in this image,
  // so we point noVNC at the root.
  var wsUrl = 'ws://' + host + ':3000/';

  function setStatus(state, msg) {
    statusDot.className = 'status' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
    statusLabel.textContent = msg;
  }

  function loadScript(src) {
    // noVNC 1.4+ ships core/rfb.js as an ES module. Load via
    // dynamic import (the script tag is type=module to satisfy the
    // browser's ESM rules). The default export is the RFB class.
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.type = 'module';
      s.textContent = "import('" + src + "').then(m => { window.RFB = m.default; }).catch(e => { window.__rfbLoadError = e; });";
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
      // poll for either RFB or load error
      var waited = 0;
      var t = setInterval(function () {
        if (typeof window.RFB === 'function') { clearInterval(t); resolve(); return; }
        if (window.__rfbLoadError) { clearInterval(t); reject(window.__rfbLoadError); return; }
        if (++waited > 100) { clearInterval(t); reject(new Error('timeout loading ' + src)); }
      }, 100);
    });
  }

  function connect() {
    setStatus('', 'connecting…');
    placeholder.style.display = 'flex';
    placeholder.textContent = 'Connecting to ' + wsUrl + '…';
    loadScript(NO_VNC_URL).then(function () {
      if (typeof window.RFB !== 'function') {
        throw new Error('noVNC RFB class not found after load');
      }
      var canvas = document.createElement('canvas');
      screen.innerHTML = '';
      screen.appendChild(canvas);
      var zoomEl = document.getElementById('zoom');
      if (zoomEl) screen.appendChild(zoomEl);

      rfb = new window.RFB(canvas, wsUrl, {
        repeaterID: 'akroncloud-mobile',
        public: false,
        viewOnly: false,
        clipViewport: false,
        resizeSession: true,
        showDotCursor: true,
        background: '#000',
        qualityLevel: 6,
        compressionLevel: 2,
      });
      rfb.addEventListener('connect', function () {
        setStatus('ok', 'connected to MT5');
        placeholder.style.display = 'none';
        fit();
      });
      rfb.addEventListener('disconnect', function (e) {
        setStatus('err', 'disconnected' + (e && e.detail && e.detail.reason ? ': ' + e.detail.reason : ''));
        placeholder.style.display = 'flex';
        placeholder.textContent = 'Disconnected. Tap ↻ to retry.';
      });
      rfb.addEventListener('credentialsrequired', function () {
        setStatus('', 'credentials required (server-side)');
      });
    }).catch(function (e) {
      setStatus('err', 'load failed: ' + e.message);
      placeholder.textContent = 'Could not load noVNC: ' + e.message;
    });
  }

  function sendChar(ch) {
    if (!rfb) return;
    var baseCh = ch.toLowerCase();
    var keysym = XK[baseCh] || XK[ch] || ch.charCodeAt(0);
    rfb.sendKey(keysym, true);
    rfb.sendKey(keysym, false);
  }
  function sendKeyName(name) {
    if (!rfb) return;
    var keysym = NAMED_KEYS[name] || XK[name];
    if (!keysym) return;
    rfb.sendKey(keysym, true);
    rfb.sendKey(keysym, false);
  }
  function sendMacro(macro) {
    if (!rfb) return;
    if (macro === 'esc' || macro === 'tab' || macro === 'enter' || macro === 'f2') {
      sendKeyName(macro);
      return;
    }
    if (macro.indexOf('ctrl-') === 0) {
      var key = macro.slice(5);
      rfb.sendKey(0xFFE3, true);
      rfb.sendKey(XK[key.toLowerCase()] || XK[key] || key.toUpperCase().charCodeAt(0), true);
      rfb.sendKey(XK[key.toLowerCase()] || XK[key] || key.toUpperCase().charCodeAt(0), false);
      rfb.sendKey(0xFFE3, false);
      return;
    }
  }

  var XK = {
    ' ': 0x20,
    '!': 0x21, '"': 0x22, '#': 0x23, '$': 0x24, '%': 0x25, '&': 0x26,
    "'": 0x27, '(': 0x28, ')': 0x29, '*': 0x2A, '+': 0x2B, ',': 0x2C,
    '-': 0x2D, '.': 0x2E, '/': 0x2F,
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
  var NAMED_KEYS = {
    'esc':    0xFF1B,
    'tab':    0xFF09,
    'enter':  0xFF0D,
    'f2':     0xFFBE,
  };

  function pressKey(ch) {
    if (ch === 'shift') {
      shift = !shift;
      document.querySelectorAll('[data-key="shift"]').forEach(function (b) {
        b.style.opacity = shift ? '1' : '0.6';
      });
      return;
    }
    if (ch === 'backspace') { sendKeyName('BackSpace'); shift = false; return; }
    if (ch === 'enter')    { sendKeyName('enter');                 return; }
    if (ch === 'space')    { sendChar(' ');                        return; }
    if (ch === '-')        { sendChar('-');                        return; }
    if (ch === '.')        { sendChar('.');                        return; }
    var out = shift ? ch.toUpperCase() : ch;
    sendChar(out);
    if (shift) {
      shift = false;
      document.querySelectorAll('[data-key="shift"]').forEach(function (b) {
        b.style.opacity = '0.6';
      });
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
    var fields = [
      { value: creds.server,   allowShift: true },
      { value: creds.login,    allowShift: true },
      { value: creds.password, allowShift: true },
    ];
    if (creds.investor) fields.push({ value: creds.investor, allowShift: true });
    var i = 0;
    function next() {
      if (i >= fields.length) {
        setTimeout(function () { sendKeyName('enter'); }, 200);
        return;
      }
      var f = fields[i++];
      if (!f.value) { next(); return; }
      typeString(f.value, function () {
        if (i < fields.length) {
          setTimeout(function () { sendKeyName('tab'); next(); }, 150);
        } else {
          next();
        }
      });
    }
    function typeString(s, done) {
      var chars = s.split('');
      var j = 0;
      function tick() {
        if (j >= chars.length) { done(); return; }
        var c = chars[j++];
        if (/[A-Z]/.test(c)) {
          sendKeyName('shift_L');
        }
        setTimeout(function () { pressKey(c.toLowerCase()); tick(); }, 35);
      }
      tick();
    }
    next();
  }

  function setZoom(z) {
    zoom = Math.max(0.5, Math.min(3, z));
    var canvas = screen.querySelector('canvas');
    if (canvas) {
      canvas.style.transform = 'scale(' + zoom + ')';
      canvas.style.transformOrigin = '0 0';
    }
  }
  function fit() {
    var canvas = screen.querySelector('canvas');
    if (!canvas) return;
    var sw = screen.clientWidth, sh = screen.clientHeight;
    var cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;
    var z = Math.min(sw / cw, sh / ch);
    setZoom(z);
  }

  document.querySelectorAll('[data-key]').forEach(function (b) {
    b.addEventListener('click', function () { pressKey(b.dataset.key); });
  });
  document.querySelectorAll('[data-macro]').forEach(function (b) {
    b.addEventListener('click', function () { sendMacro(b.dataset.macro); });
  });
  document.querySelectorAll('[data-zoom]').forEach(function (b) {
    b.addEventListener('click', function () {
      var z = b.dataset.zoom;
      if (z === 'in')  setZoom(zoom * 1.25);
      else if (z === 'out') setZoom(zoom / 1.25);
      else setZoom(parseFloat(z));
    });
  });
  credbtn.addEventListener('click', openCreds);
  document.getElementById('credcancel').addEventListener('click', closeCreds);
  document.getElementById('credfill').addEventListener('click', function () {
    closeCreds();
    fillFromCreds();
  });
  document.getElementById('credform').addEventListener('submit', function (e) {
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
  reloadbtn.addEventListener('click', function () {
    if (rfb) rfb.disconnect();
    setTimeout(connect, 200);
  });
  fitbtn.addEventListener('click', fit);
  window.addEventListener('resize', fit);

  connect();
})();
</script>
</body>
</html>`;