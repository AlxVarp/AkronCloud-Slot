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
      touch-action: none;
    }
    #screen canvas { display: block; transform-origin: 0 0; }
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
const { default: MouseButtonMapper } = await import('/vnc-static/core/mousebuttonmapper.js');

// Bundle-without-UI prototype shims. The /mobile wrapper does the
// same thing — keep these in sync if you change either.
if (!RFB.prototype.ui) RFB.prototype.ui = {};
if (typeof RFB.prototype.ui.hookConnectCallback !== 'function') {
  RFB.prototype.ui.hookConnectCallback = function() {};
}

// Drain the KasmVNC fork's UnixRelaySub message (msgType 140) instead
// of letting the default _handleSubscribeUnixRelay explode with
// "Cannot read property rQshift8 of null" on the first socket error.
// Same drain semantics as _rQwait/_rQshiftStr so the message
// dispatcher stays in sync. Ported from mobile.html.ts — without
// this, the very first message can desync the WS receive queue and
// leave the framebuffer broken.
const _origHandleSubscribeUnixRelay = RFB.prototype._handleSubscribeUnixRelay;
RFB.prototype._handleSubscribeUnixRelay = function () {
  if (!this._sock) return false;
  if (this._sock.rQwait('UnixRelaySub header', 2, 1)) return false;
  const status = this._sock.rQshift8();
  const len = this._sock.rQshift8();
  if (this._sock.rQwait('UnixRelaySub payload', len, 3)) return false;
  this._sock.rQshiftStr(len);
  return false;
};
RFB.prototype._origHandleSubscribeUnixRelay = _origHandleSubscribeUnixRelay;

// Lazy-init the mouseButtonMapper that the bundled UI normally assigns
// in ui.js. Without this, the first mouse event on the canvas throws
// "Cannot read property 'get' of null" inside the RFB _handleMouse
// path, which kills the framebuffer update pipeline. Same fix as
// mobile.html.ts.
const _origHandleMouse = RFB.prototype._handleMouse;
RFB.prototype._handleMouse = function (ev) {
  if (!this.mouseButtonMapper) {
    const m = new MouseButtonMapper();
    m.set(0, 1); m.set(1, 2); m.set(2, 3); m.set(3, 8); m.set(4, 9);
    this.mouseButtonMapper = m;
  }
  return _origHandleMouse.call(this, ev);
};

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
  // Force the drawing surface dimensions. The KasmVNC Xvnc fork in
  // this image doesn't push an initial framebuffer update on connect,
  // so the noVNC RFB client never sets canvas.width/height from the
  // server's framebuffer size — the canvas stays at 0x0 and the
  // user sees a black screen. Mirroring desktopW/desktopH into the
  // canvas attributes ensures the drawing surface is always the right
  // size; the noVNC client can still override later if it does
  // receive a different size.
  if (canvas.width !== desktopW)  canvas.width  = desktopW;
  if (canvas.height !== desktopH) canvas.height = desktopH;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
}

function getUrl() {
  const u = DEFAULT_URL.trim();
  if (u.startsWith('ws://') || u.startsWith('wss://')) return u;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + (u.startsWith('/') ? u : '/' + u);
}

// Force the RFB client's inner wrapper <div> + canvas to be properly
// positioned/displayed. The KasmVNC fork's noVNC inlines
// \`display:flex; margin:auto\` on the canvas via its constructor,
// which wins over author CSS via inline style specificity. Without
// the explicit overrides below, the canvas is sometimes drawn at
// 0x0 (especially in iframes / non-trivial layouts) and the user
// sees a blank screen even though the RFB connection is live. This
// is the same fix the /mobile wrapper uses (see mobile.html.ts).
function applyCanvasCentering() {
  const rfbScreen = screenEl.querySelector('div');
  if (rfbScreen) {
    rfbScreen.style.position = 'relative';
    rfbScreen.style.width = '100%';
    rfbScreen.style.height = '100%';
    rfbScreen.style.display = 'block';
  }
  const canvas = screenEl.querySelector('canvas');
  if (canvas) {
    canvas.style.position = 'absolute';
    canvas.style.top = '50%';
    canvas.style.left = '50%';
    canvas.style.margin = '0';
    canvas.style.transform = 'translate(-50%, -50%)';
  }
}

// Fit + refresh: scale the RFB viewport, request a fresh framebuffer
// update from the server (KasmVNC won't push a new frame on a
// re-connect without an explicit request), and re-apply the canvas
// centering. Same as /mobile's \`fit()\` helper.
function fit() {
  if (!rfb) return;
  setStatus('ok', 'refitting + refreshing framebuffer…');
  try { rfb._updateScale(); } catch (e) { /* defensive */ }
  try {
    RFB.messages.fbUpdateRequest(rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
  } catch (e) { /* defensive */ }
  applyCanvasCentering();
  setTimeout(() => setStatus('ok', 'refreshed (' + (rfb._fbWidth || 0) + 'x' + (rfb._fbHeight || 0) + ')'), 350);
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

  // Clear the target so RFB's wrapper div + canvas become the only
  // children of #screen. Without this, the placeholder div sits as
  // the first child and applyCanvasCentering() (which does
  // screenEl.querySelector('div')) ends up styling the placeholder
  // instead of RFB's wrapper — the canvas gets nested inside the
  // placeholder's flex container and is rendered at 0x0 or hidden
  // behind the placeholder's z-index:5 layer. /mobile does the same.
  screenEl.innerHTML = '';

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
    // fit() (defined below) calls applyCanvasCentering() + sends a
    // non-incremental FramebufferUpdateRequest to KasmVNC. KasmVNC
    // does NOT push a fresh framebuffer update on its own after the
    // RFB handshake — without this request the canvas stays black
    // even though the connection is live. This is the same fix
    // /mobile uses; the previous desktop wrapper only called
    // fitScreen() in the connect listener, which sizes the canvas
    // but never asks the server for pixels.
    fit();
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
  // Perf settings — match /mobile. Without these, the RFB client uses
  // its defaults (no compression, no JPEG, full-frame Raw encoding on
  // every update), which on a 1024x768 desktop is ~4.3x more bytes
  // per frame than /mobile's 414x440 and very visibly laggy.
  //
  // resizeSession=false: don't send SetDesktopSize on viewport
  // changes (Xvnc doesn't honor it anyway, and sending it costs a
  // round-trip on every browser resize).
  // qualityLevel=6: 0=worst/biggest, 9=best/smallest. 6 is a good
  // middle for the candle charts (text stays readable, gradients
  // don't band visibly).
  // compressionLevel=2: 0=off, 9=highest. KasmVNC already does Tight
  // zlib but its level is hardcoded; bumping this also tells the
  // client to prefer zrle/tight over raw rectangles, which is the
  // bulk of the savings for static chart backgrounds.
  rfb.resizeSession = false;
  rfb.scaleViewport = false; // we do our own letterboxed fit
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
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
  setTimeout(fit, 1000);
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
