/**
 * Desktop-friendly VNC wrapper for KasmVNC.
 *
 * /desktop is a separate page from /mobile. Goals:
 *   1. Show the VNC canvas at the host's native 1024x768 resolution
 *      (set by Xvnc -geometry inside the container) — no mobile
 *      shrink-to-fit, no virtual keyboard, the real keyboard works
 *      because the RFB client captures key events from the canvas.
 *   2. Optional inline settings panel (host/port/path + password
 *      overrides) so a PC user can connect to a non-default
 *      KasmVNC backend if needed.
 *   3. Compact credentials sheet (same one-tap broker fill as
 *      /mobile, but tighter spacing and a one-line form).
 *
 * The RFB client class (noVNC) and the WebSocket proxy
 * (/mt5-ws → ws://127.0.0.1:3000/websockify) are shared with
 * /mobile. The only difference is the layout.
 *
 * Re-uses /vnc-static/core/rfb.js (KasmVNC's bundled noVNC) so
 * the same WebSocket endpoint works for both.
 */

export const DESKTOP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1024, initial-scale=1" />
  <meta name="theme-color" content="#0b0e14" />
  <title>akroncloud-slot · desktop VNC</title>
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
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overscroll-behavior: none;
      -webkit-tap-highlight-color: transparent;
    }
    /* App fills the viewport: topbar (compact) + screen. The screen
       scales its RFB canvas to fit the remaining height while
       preserving the host's 1024x768 aspect. */
    #app { display: flex; flex-direction: column; height: 100dvh; height: 100vh; }

    /* Slim topbar: status + label + 4 buttons. Single line, low
       profile so the VNC canvas gets the bulk of vertical space. */
    #topbar {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      font-size: 12px;
      height: 28px;
    }
    #topbar .status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--muted);
    }
    #topbar .status.ok { background: var(--ok); }
    #topbar .status.err { background: var(--danger); }
    #topbar .label {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--muted);
    }
    #topbar button {
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 10px; font-size: 12px;
      cursor: pointer;
    }
    #topbar button:hover { background: #21262d; }
    #topbar button:active { background: #30363d; }
    #topbar button.primary {
      background: var(--accent); color: #fff; border-color: var(--accent);
    }
    #topbar button.primary:disabled { opacity: .5; cursor: not-allowed; }

    /* Screen area: holds the RFB canvas, centered, scaled to fit.
       The canvas is rendered at 1024x768 (host Xvnc resolution) and
       scaled with CSS transform to fit the available area while
       preserving aspect ratio. JS computes the scale on every
       window resize. */
    #screen {
      flex: 1; min-height: 0;
      background: #0b0e14;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #screen canvas {
      display: block;
      transform-origin: center center;
      image-rendering: -webkit-optimize-contrast;
    }
    #placeholder {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 13px; text-align: center; padding: 24px;
      z-index: 5;
      pointer-events: none;
    }

    /* Floating action button (bottom-right corner). Always visible
       regardless of topbar state. The status dot is the live MT5
       state; click opens a popover with quick actions so the user
       doesn't have to reach for the slim topbar. The popover
       is the same popover menu used in the mobile wrapper, lifted
       into the desktop so the user can reach it from anywhere on
       screen. */
    #fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 50;
      display: flex; flex-direction: column; align-items: flex-end;
      gap: 8px;
    }
    #fab .trigger {
      width: 48px; height: 48px;
      border-radius: 50%;
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--fg);
      box-shadow: 0 6px 20px rgba(0,0,0,.45);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      position: relative;
      transition: transform .12s ease, background .12s ease;
    }
    #fab .trigger:hover { background: #21262d; }
    #fab .trigger:active { transform: scale(.96); }
    #fab .trigger .status {
      position: absolute;
      top: 6px; right: 6px;
      width: 10px; height: 10px;
      border-radius: 50%;
      background: var(--muted);
      box-shadow: 0 0 0 2px var(--panel);
    }
    #fab .trigger .status.ok { background: var(--ok); }
    #fab .trigger .status.err { background: var(--danger); }
    #fab .trigger .icon {
      font-size: 18px;
      line-height: 1;
    }
    #fab .menu {
      display: none;
      flex-direction: column;
      min-width: 200px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,.45);
      overflow: hidden;
    }
    #fab.open .menu { display: flex; }
    #fab .menu button {
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      background: transparent;
      color: var(--fg);
      border: 0;
      border-bottom: 1px solid var(--border);
      padding: 10px 14px;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    #fab .menu button:last-child { border-bottom: 0; }
    #fab .menu button:hover { background: #21262d; }
    #fab .menu button.primary {
      background: var(--accent);
      color: #fff;
    }
    #fab .menu .icon {
      width: 16px; text-align: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    #fab .menu .label {
      flex: 1;
    }

    /* Settings modal: KasmVNC backend connection settings. */
    #settings {
      position: fixed; inset: 0; background: rgba(0,0,0,.6);
      display: none; align-items: center; justify-content: center;
      z-index: 100; padding: 16px;
    }
    #settings.open { display: flex; }
    #settings .panel {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 20px;
      width: 100%; max-width: 460px;
    }
    #settings h2 { margin: 0 0 4px; font-size: 14px; }
    #settings p { color: var(--muted); margin: 0 0 12px; font-size: 12px; }
    #settings label {
      display: block; font-size: 11px; color: var(--muted);
      margin: 8px 0 4px;
    }
    #settings input {
      width: 100%; padding: 6px 8px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", monospace;
    }
    #settings .row { display: flex; gap: 8px; margin-top: 16px; }
    #settings button {
      flex: 1; padding: 8px; font-size: 12px;
      background: var(--accent); color: #fff; border: 0;
      border-radius: 4px; cursor: pointer;
    }
    #settings button.ghost {
      background: transparent; color: var(--fg);
      border: 1px solid var(--border);
    }

    /* Credentials modal: one-tap broker fill (same UX as /mobile,
       tighter form for desktop). */
    #credsheet {
      position: fixed; inset: 0; background: rgba(0,0,0,.7);
      display: none; align-items: center; justify-content: center;
      z-index: 100; padding: 16px;
    }
    #credsheet.open { display: flex; }
    #credsheet form {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px 20px;
      width: 100%; max-width: 480px;
    }
    #credsheet h2 { margin: 0 0 4px; font-size: 14px; }
    #credsheet p { color: var(--muted); margin: 0 0 12px; font-size: 12px; }
    #credsheet label {
      display: block; font-size: 11px; color: var(--muted);
      margin: 8px 0 4px;
    }
    #credsheet input {
      width: 100%; padding: 6px 8px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 4px;
      font-size: 13px;
    }
    #credsheet .row { display: flex; gap: 8px; margin-top: 16px; }
    #credsheet button {
      flex: 1; padding: 8px; font-size: 12px; font-weight: 500;
      background: var(--accent); color: #fff; border: 0;
      border-radius: 4px; cursor: pointer;
    }
    #credsheet button.ghost {
      background: transparent; color: var(--fg);
      border: 1px solid var(--border);
    }
    #credsheet textarea {
      width: 100%; padding: 6px 8px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, monospace;
      resize: vertical;
    }
  </style>
</head>
<body>
<div id="app">
<div id="fab">
  <div class="menu" role="menu" aria-label="Quick actions">
    <button id="fab_login" class="primary" type="button">
      <span class="icon">🔑</span>
      <span class="label">Broker login</span>
    </button>
    <button id="fab_sync" type="button">
      <span class="icon">🔄</span>
      <span class="label">Resync account</span>
    </button>
    <button id="fab_settings" type="button">
      <span class="icon">⚙</span>
      <span class="label">Backend settings</span>
    </button>
    <button id="fab_reconnect" type="button">
      <span class="icon">↻</span>
      <span class="label">Reconnect VNC</span>
    </button>
  </div>
  <button class="trigger" id="fab_trigger" type="button"
          aria-label="Quick actions" aria-haspopup="true">
    <span class="status" id="fab_status"></span>
    <span class="icon">⚡</span>
  </button>
</div>

<div id="topbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="credsbtn">Login</button>
    <button id="syncbtn" disabled>Sync</button>
    <button id="settingsbtn" title="KasmVNC backend settings">⚙</button>
    <button id="reloadbtn" title="Reconnect">↻</button>
  </div>

  <div id="screen">
    <div id="placeholder">Loading KasmVNC RFB client…</div>
  </div>
</div>

<div id="settings">
  <div class="panel">
    <h2>KasmVNC backend</h2>
    <p>Override only if you know what you're doing. The defaults connect
       to this slot's KasmVNC via the same-origin WebSocket proxy.</p>
    <label>WebSocket URL</label>
    <input id="s_url" value="/mt5-ws" />
    <label>Password (KasmVNC, if any)</label>
    <input id="s_password" type="password" placeholder="(none — slot's KasmVNC is open)" />
    <div class="row">
      <button type="button" class="ghost" id="settingscancel">Cancel</button>
      <button type="button" id="settingsconnect">Connect</button>
    </div>
  </div>
</div>

<div id="credsheet">
  <form id="credform">
    <h2>Broker credentials</h2>
    <p>Stored in this browser only. Used to auto-fill the MT5 login form.</p>
    <label>Server</label>
    <input id="f_server" autocomplete="off" />
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
    <h2 style="font-size: 13px; margin-top: 0;">Custom text</h2>
    <p>Types into whatever MT5 field is currently focused.</p>
    <textarea id="f_custom" rows="3" placeholder="e.g. Demo-Deriv-01 or a long server name"></textarea>
    <div class="row">
      <button type="button" class="ghost" id="credtypecustom">Type custom</button>
      <button type="button" class="ghost" id="credresetmt5">Reset MT5 input</button>
      <button type="button" class="ghost" id="credclearstored">Clear saved</button>
    </div>
  </form>
</div>

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');

// Same bundle-without-UI prototype shims as the mobile client. We
// don't want KasmVNC's externalConnectBar, settings panel, or
// disconnect overlay — the slot is single-user, single-tenant.
if (!RFB.prototype.ui) RFB.prototype.ui = {};
if (typeof RFB.prototype.ui.hookConnectCallback !== 'function') {
  RFB.prototype.ui.hookConnectCallback = function() {};
}

// Persistent settings. KasmVNC is open by default (no password)
// so the slot's /desktop doesn't ask the user to type one.
const SETTINGS_KEY = 'akron-desktop-settings';
const CREDS_KEY = 'akron-broker-creds';
const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
const creds = JSON.parse(localStorage.getItem(CREDS_KEY) || 'null');

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const statusLabelEl = $('statuslabel');
const screenEl = $('screen');
const placeholderEl = $('placeholder');

let rfb = null;
let connecting = false;
let connected = false;

const DEFAULT_URL = '/mt5-ws';
// Target the host's native 1024x768 Xvnc geometry by default, but
// ask KasmVNC to grow it to 1920x1080 (real desktop) on every
// connect. If the server accepts (KasmVNC does), MT5 lays out at
// 1920x1080 — chart candles, panels, all get the full desktop's
// worth of pixels and stay sharp when the browser window is
// 1920x1080 or smaller. If the server rejects (e.g. Xvnc is
// pinned to 1024x768 in the Dockerfile), we keep the 1024x768
// buffer and the CSS scale-up handles the rest.
const FALLBACK_W = 1024;
const FALLBACK_H = 768;
const REQUEST_W = 1920;
const REQUEST_H = 1080;
let desktopW = FALLBACK_W; // updated by desktoplayout events
let desktopH = FALLBACK_H;

function setStatus(state, text) {
  statusEl.className = 'status' + (state ? ' ' + state : '');
  statusLabelEl.textContent = text;
}

function fitScreen() {
  if (!rfb) return;
  // The RFB canvas is rendered at desktopW × desktopH (the server's
  // current virtual desktop size, updated via the desktoplayout
  // event). We scale it to fit the available area while preserving
  // the aspect ratio — letterboxing on the constrained axis. This
  // gives a sharp 1:1 render on screens at-or-above the target and
  // a clean downscale on smaller windows (no blurry upscale).
  const wrap = screenEl.getBoundingClientRect();
  const scale = Math.min(
    wrap.width  / desktopW,
    wrap.height / desktopH,
  );
  const w = Math.floor(desktopW * scale);
  const h = Math.floor(desktopH * scale);
  const canvas = rfb.getCanvas?.() || rfb._canvas || screenEl.querySelector('canvas');
  if (!canvas) return;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
}

function getUrl() {
  const u = (settings.url || DEFAULT_URL).trim();
  if (u.startsWith('ws://') || u.startsWith('wss://')) return u;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + (u.startsWith('/') ? u : '/' + u);
}

function disconnect() {
  if (rfb) {
    try { rfb.disconnect(); } catch (_) {}
    try { rfb.getCanvas()?.remove(); } catch (_) {}
    rfb = null;
  }
  connected = false;
  connecting = false;
  setStatus('', 'disconnected');
}

function connect() {
  if (connecting) return;
  disconnect();
  connecting = true;
  setStatus('', 'connecting…');
  placeholderEl.textContent = 'Connecting to KasmVNC…';

  const url = getUrl();
  const password = (settings.password || '').trim() || undefined;

  // KasmVNC fork of RFB has signature:
  //   constructor(target, touchInput, urlOrChannel, options, isPrimaryDisplay)
  // The URL is the 3rd positional arg, not the 2nd. Passing the URL as
  // touchInput causes Keyboard to assign .value on the string and the
  // Websock.attach() check to find that the URL-string isn't a
  // WebSocket (missing 'send' / 'close' / 'binaryType' properties)
  // and throw "Raw channel missing property: send". We pass null for
  // touchInput (no IME on the MT5 canvas itself; the desktop
  // wrapper's settings modal types via rfb.sendKey).
  // 5th positional: isPrimaryDisplay = true.
  rfb = new RFB(screenEl, null, url, {
    background: '#000',
    shared: true,
    repeaterID: '',
    credentials: password ? { password } : undefined,
  }, true);

  rfb.addEventListener('connect', () => {
    connecting = false;
    connected = true;
    setStatus('ok', 'connected');
    placeholderEl.style.display = 'none';
    fitScreen();
    // Ask KasmVNC to grow the virtual desktop to 1920x1080 once. The
    // RFB gate (rfb.js:1595) lets SetDesktopSize go through when
    // either resizeSession or forcedResolutionX/Y is set. We use
    // forcedResolution (vs resizeSession=true) so the Xvnc is
    // pinned to 1920x1080 exactly — no per-window-resize renegotiation
    // (which would jitter MT5 charts every time the user moves the
    // browser). If KasmVNC rejects the request, the canvas keeps
    // its original buffer size and CSS scales up.
    try {
      rfb.forcedResolutionX = REQUEST_W;
      rfb.forcedResolutionY = REQUEST_H;
      // Trigger the request via the resizeSession flow (read by the
      // gate at the top of _handleDesktopResize).
      rfb.resizeSession = true;
      // …but undo the autoresize-on-every-resize side-effect by
      // flipping it off right after the first request. Next user
      // resize just re-fits the CSS canvas, not the Xvnc.
      setTimeout(() => { rfb.resizeSession = false; }, 250);
    } catch (_) { /* server may not support it */ }
  });
  rfb.addEventListener('disconnect', (e) => {
    connecting = false;
    connected = false;
    setStatus('err', 'disconnected' + (e?.detail?.reason ? ' (' + e.detail.reason + ')' : ''));
    placeholderEl.style.display = 'flex';
    placeholderEl.textContent = 'Disconnected. Click ↻ to reconnect.';
  });
  rfb.addEventListener('securityfailure', (e) => {
    setStatus('err', 'security failure: ' + (e?.detail?.reason || 'unknown'));
  });
  rfb.addEventListener('capabilities', () => {
    fitScreen();
  });
  rfb.addEventListener('desktoplayout', (e) => {
    // Server confirmed the new (or original) desktop size. Update
    // the cached dimensions so fitScreen uses the right scale, then
    // re-fit. The detail usually carries { width, height } in
    // server coordinates; we use a defensive fallback for older
    // server versions.
    const w = e?.detail?.width  || rfb._fbWidth  || desktopW;
    const h = e?.detail?.height || rfb._fbHeight || desktopH;
    if (w > 0 && h > 0) {
      desktopW = w;
      desktopH = h;
    }
    fitScreen();
  });
  rfb.scaleViewport = false; // we do our own letterboxed fit
}

window.addEventListener('resize', fitScreen);
window.addEventListener('keydown', (e) => {
  // Pass real keyboard input to the focused canvas. The RFB client
  // already does this when the canvas has focus, but on some
  // browsers the page-level focus is on the body. Forwarding from
  // window ensures keys are captured regardless of focus.
  if (!connected) return;
  const canvas = rfb?.getCanvas?.();
  if (canvas) canvas.focus();
});

// Topbar buttons
$('reloadbtn').addEventListener('click', () => { disconnect(); setTimeout(connect, 100); });
$('syncbtn').addEventListener('click', async () => {
  if (!connected) return;
  try {
    const r = await fetch('/v1/sync', { method: 'POST' });
    setStatus(r.ok ? 'ok' : 'err', r.ok ? 'sync ok' : 'sync failed');
  } catch (e) {
    setStatus('err', 'sync error: ' + e.message);
  }
});

// Settings modal
$('settingsbtn').addEventListener('click', () => {
  $('s_url').value = settings.url || DEFAULT_URL;
  $('s_password').value = settings.password || '';
  $('settings').classList.add('open');
});
$('settingscancel').addEventListener('click', () => $('settings').classList.remove('open'));
$('settingsconnect').addEventListener('click', () => {
  settings.url = $('s_url').value.trim() || DEFAULT_URL;
  settings.password = $('s_password').value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  $('settings').classList.remove('open');
  $('reloadbtn').click();
});

// Credentials modal (same UX as /mobile but desktop-tight)
$('credsbtn').addEventListener('click', () => {
  $('f_server').value = creds?.server || '';
  $('f_login').value = creds?.login || '';
  $('f_password').value = creds?.password || '';
  $('f_investor').value = creds?.investor || '';
  $('credsheet').classList.add('open');
  setTimeout(() => $('f_server').focus(), 50);
});
$('credcancel').addEventListener('click', () => $('credsheet').classList.remove('open'));
$('credfill').addEventListener('click', () => doFill());
$('credform').addEventListener('submit', (e) => {
  e.preventDefault();
  saveCredsFromForm();
  doFill();
});
$('credtypecustom').addEventListener('click', () => doTypeCustom());
$('credresetmt5').addEventListener('click', () => doResetMt5());
$('credclearstored').addEventListener('click', () => {
  localStorage.removeItem(CREDS_KEY);
  $('credsheet').classList.remove('open');
});

function saveCredsFromForm() {
  const c = {
    server: $('f_server').value.trim(),
    login:  $('f_login').value.trim(),
    password:    $('f_password').value,
    investor:    $('f_investor').value,
  };
  localStorage.setItem(CREDS_KEY, JSON.stringify(c));
  Object.assign(creds || (creds = {}), c);
}

// One-tap fill: type server / login / password into whatever MT5
// input fields are currently focused. Mirrors /mobile's behavior
// (Ctrl+A then Delete, then type) so it works the same way.
const KEY_DELAY = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendKey(key) {
  if (!rfb?.sendKey) return;
  rfb.sendKey(key);
  await sleep(KEY_DELAY);
}
async function selectAllAndDelete() {
  await sendKey(0xffe3); // Control_L down
  await sendKey(0x0061);  // 'a'
  await sendKey(0xffe4);  // Control_L up
  await sendKey(0xffff);  // Delete
}
async function doFill() {
  $('credsheet').classList.remove('open');
  if (!creds?.server) return;
  // Tab to the server field if needed: the MT5 login dialog has
  // a "Server" combobox, "Login" textbox, "Password" textbox, and
  // an "OK" button. Send a few tabs to walk through.
  await sleep(120);
  for (const c of creds.server) {
    if (c === ':') await sendKey(0x003a);
    else if (/^[a-z0-9]$/i.test(c)) {
      const code = c.toUpperCase().charCodeAt(0);
      await sendKey(code);
    } else {
      await sendKey(c.charCodeAt(0));
    }
  }
  await sendKey(0xff09); // Tab
  for (const c of creds.login) {
    await sendKey(c.charCodeAt(0));
  }
  await sendKey(0xff09); // Tab
  for (const c of creds.password) {
    await sendKey(c.charCodeAt(0));
  }
  // Don't auto-press Enter — the user reviews the form and submits
  // themselves, which is safer if the creds are wrong.
}

async function doTypeCustom() {
  const text = $('f_custom').value;
  $('credsheet').classList.remove('open');
  for (const c of text) await sendKey(c.charCodeAt(0));
}

async function doResetMt5() {
  $('credsheet').classList.remove('open');
  await selectAllAndDelete();
}

// Floating action button: popover with quick actions. Mirrors the
// topbar buttons so the user doesn't have to reach for the slim
// topbar at the top of the page; especially useful when running
// fullscreen. The trigger button shows the live MT5 connection
// status (color-coded dot) and toggles a popover with the same
// actions as the topbar (login, sync, settings, reconnect).
const fab = $('fab');
const fabStatus = $('fab_status');
$('fab_trigger').addEventListener('click', () => {
  fab.classList.toggle('open');
});
// Close the popover when clicking outside the FAB.
document.addEventListener('click', (ev) => {
  if (!fab.contains(ev.target)) fab.classList.remove('open');
});
// Sync the FAB status dot with the live state (mirror of #status).
const fabSync = new MutationObserver(() => {
  const cls = $('status').className;
  fabStatus.className = 'status' + (cls.includes('ok') ? ' ok' : cls.includes('err') ? ' err' : '');
});
fabSync.observe($('status'), { attributes: true, attributeFilter: ['class'] });
fabStatus.className = 'status'; // initial: gray = connecting
// FAB menu actions — mirror the topbar buttons.
$('fab_login').addEventListener('click', () => { fab.classList.remove('open'); $('credsbtn').click(); });
$('fab_sync').addEventListener('click',   () => { fab.classList.remove('open'); $('syncbtn').click(); });
$('fab_settings').addEventListener('click', () => { fab.classList.remove('open'); $('settingsbtn').click(); });
$('fab_reconnect').addEventListener('click', () => { fab.classList.remove('open'); $('reloadbtn').click(); });
// Close on Escape so the popover doesn't trap focus.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && fab.classList.contains('open')) {
    fab.classList.remove('open');
  }
});

// Boot
connect();
</script>
</body>
</html>
`;