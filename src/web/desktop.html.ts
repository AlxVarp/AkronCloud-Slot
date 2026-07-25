/**
 * /desktop — desktop-friendly VNC wrapper for KasmVNC.
 *
 * Same architecture as /mobile (mobile.html.ts):
 *   1. Loads KasmVNC's bundled noVNC core (served same-origin at
 *      /vnc-static/core/rfb.js — copied from /usr/local/share/kasmvnc/www
 *      at build time).
 *   2. Renders MT5 in a full-viewport canvas; desktop mode keeps
 *      the native 1024x768 resolution with letterbox scaling.
 *   3. **No virtual keyboard** — the real keyboard works because
 *      the RFB client captures key events from the canvas. This is
 *      the key difference from /mobile (which has the on-screen
 *      keyboard for touch devices).
 *   4. Floating action button (FAB) at the bottom-right for
 *      quick access to broker login / resync / reconnect. (The
 *      credential-fill feature is in /mobile's flow only; on
 *      desktop the user types into the MT5 GUI directly via the
 *      real keyboard, so we don't replicate the modal here.)
 *
 * WebSocket URL: /mt5-ws (proxied to ws://127.0.0.1:3000/websockify
 * inside the slot). Same-origin WS avoids port-3000 firewall issues
 * from any browser.
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
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    #app { display: flex; flex-direction: column; height: 100dvh; height: 100vh; }

    /* Screen area: holds the RFB canvas, centered, scaled to fit.
       The canvas is rendered at 1024x768 (host Xvnc resolution) and
       scaled with CSS transform to fit the available area while
       preserving aspect ratio. */
    #screen {
      flex: 1; min-height: 0;
      background: #0b0e14;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #screen canvas { display: block; transform-origin: center center; }
    #placeholder {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 14px; text-align: center; padding: 24px;
      z-index: 5; pointer-events: none;
    }

    /* Status strip (left) + reconnect button (right). Lighter than
       the mobile topbar because the FAB carries most quick actions
       on desktop. */
    #statusbar {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      height: 28px;
      font-size: 12px;
    }
    #statusbar .status {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; background: var(--muted);
    }
    #statusbar .status.ok  { background: var(--ok); }
    #statusbar .status.err { background: var(--danger); }
    #statusbar .label {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--muted);
    }
    #statusbar button {
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px; padding: 3px 10px; font-size: 12px;
      cursor: pointer;
    }
    #statusbar button:hover { background: #21262d; }

    /* Floating action button (bottom-right) — same UX as /mobile. */
    #fab {
      position: fixed;
      right: 16px; bottom: 16px;
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
    }
    #fab .trigger:hover  { background: #21262d; }
    #fab .trigger:active { transform: scale(.96); }
    #fab .trigger .status {
      position: absolute; top: 6px; right: 6px;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--muted);
      box-shadow: 0 0 0 2px var(--panel);
    }
    #fab .trigger .status.ok  { background: var(--ok); }
    #fab .trigger .status.err { background: var(--danger); }
    #fab .trigger .icon     { font-size: 18px; line-height: 1; }
    #fab .menu {
      display: none; flex-direction: column;
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
      width: 100%; background: transparent; color: var(--fg);
      border: 0; border-bottom: 1px solid var(--border);
      padding: 10px 14px; font-size: 13px;
      text-align: left; cursor: pointer;
    }
    #fab .menu button:last-child { border-bottom: 0; }
    #fab .menu button:hover    { background: #21262d; }
    #fab .menu button.primary { background: var(--accent); color: #fff; }
    #fab .menu .icon    { width: 16px; text-align: center; font-size: 14px; flex-shrink: 0; }
    #fab .menu .label   { flex: 1; }
  </style>
</head>
<body>
<div id="app">
  <div id="statusbar">
    <span class="status" id="status"></span>
    <span class="label" id="statuslabel">connecting…</span>
    <button id="syncbtn" disabled>Sync</button>
    <button id="reconnectbtn" title="Reconnect">↻</button>
  </div>

  <div id="screen">
    <div id="placeholder">Loading KasmVNC RFB client…</div>
  </div>
</div>

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

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');

// Bundle-without-UI prototype shims. The /mobile wrapper does the
// same thing — keep these in sync if you change either.
if (!RFB.prototype.ui) RFB.prototype.ui = {};
if (typeof RFB.prototype.ui.hookConnectCallback !== 'function') {
  RFB.prototype.ui.hookConnectCallback = function() {};
}

const TARGET_W = 1024;
const TARGET_H = 768;
let desktopW = TARGET_W;
let desktopH = TARGET_H;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const statusLabelEl = $('statuslabel');
const screenEl = $('screen');
const placeholderEl = $('placeholder');

let rfb = null;
let connecting = false;
let connected = false;

const DEFAULT_URL = '/mt5-ws';

function setStatus(state, text) {
  statusEl.className = 'status' + (state ? ' ' + state : '');
  statusLabelEl.textContent = text;
}

function fitScreen() {
  if (!rfb) return;
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
  const u = DEFAULT_URL.trim();
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
  // Same KasmVNC RFB signature as /mobile: 3rd positional is the URL.
  // The /mobile wrapper passes null as the 2nd (touchInput). We do
  // the same here so the RFB constructor matches what the upstream
  // KasmVNC fork expects.
  rfb = new RFB(screenEl, null, url, {
    background: '#000',
  }, true);

  rfb.addEventListener('connect', () => {
    connecting = false;
    connected = true;
    setStatus('ok', 'connected');
    placeholderEl.style.display = 'none';
    fitScreen();
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
window.addEventListener('keydown', (ev) => {
  // Pass real keyboard input to the focused canvas. The RFB client
  // already does this when the canvas has focus, but on some
  // browsers the page-level focus is on the body. Forwarding from
  // window ensures keys are captured regardless of focus.
  if (!connected) return;
  const canvas = rfb?.getCanvas?.();
  if (canvas) canvas.focus();
});

// Statusbar actions
$('syncbtn').addEventListener('click', async () => {
  try {
    const r = await fetch('/v1/sync', { method: 'POST' });
    setStatus(r.ok ? 'ok' : 'err', r.ok ? 'sync ok' : 'sync failed');
  } catch (e) {
    setStatus('err', 'sync error: ' + e.message);
  }
});
$('reconnectbtn').addEventListener('click', () => {
  disconnect();
  setTimeout(connect, 100);
});

// FAB
const fab = $('fab');
const fabStatus = $('fab_status');
$('fab_trigger').addEventListener('click', () => {
  fab.classList.toggle('open');
});
document.addEventListener('click', (ev) => {
  if (!fab.contains(ev.target)) fab.classList.remove('open');
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && fab.classList.contains('open')) {
    fab.classList.remove('open');
  }
});
// Sync the FAB status dot with the live state (mirror of #status).
const fabSync = new MutationObserver(() => {
  const cls = $('status').className;
  fabStatus.className = 'status' + (cls.includes('ok') ? ' ok' : cls.includes('err') ? ' err' : '');
});
fabSync.observe($('status'), { attributes: true, attributeFilter: ['class'] });
fabStatus.className = 'status';
// FAB menu actions — mirror the topbar buttons.
$('fab_login').addEventListener('click', () => {
  fab.classList.remove('open');
  // On desktop the user types into the MT5 GUI via the real keyboard
  // (no virtual keyboard, no one-tap fill). The login button just
  // focuses the canvas so subsequent keystrokes go to the MT5.
  rfb?.getCanvas?.()?.focus();
  alert('Hacé clic en el canvas y empezá a tipear — el teclado real va directo al MT5.');
});
$('fab_sync').addEventListener('click',   () => { fab.classList.remove('open'); $('syncbtn').click(); });
$('fab_reconnect').addEventListener('click', () => { fab.classList.remove('open'); $('reconnectbtn').click(); });

// Boot
connect();
</script>
</body>
</html>
`;
