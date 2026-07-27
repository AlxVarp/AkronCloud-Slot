/**
 * /desktop — minimal desktop VNC wrapper for KasmVNC.
 *
 * debug/ea-minimal branch, v4. v3 introduced three pieces of
 * instrumentation (tabindex=0 + canvas.focus() on connect, cursor:none,
 * click counters in the status bar). It failed at runtime with
 *   "TypeError: rfb.getCanvas is not a function"
 * because the KasmVNC RFB fork does NOT expose getCanvas() as a
 * public method — the canvas is a private field (`this._canvas`,
 * see rfb.js:254). Upstream noVNC exposes it; the fork doesn't.
 * Mobile.html.ts has the same latent bug (uses `rfb?.getCanvas?.()`
 * in the FAB click handler) but never trips it because nothing
 * calls it until the user clicks the FAB.
 *
 * v4 replaces every `rfb.getCanvas()` with `screen.querySelector('canvas')`
 * — the same selector we used in v0.4ag's `applyCanvasCentering`. The
 * canvas is the only `<canvas>` element under `#screen` (RFB's
 * constructor only creates one and we wipe `screen.innerHTML = ''`
 * before attaching RFB), so a querySelector is unambiguous. We also
 * add a small helper so the call sites stay readable.
 */
export const DESKTOP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1024, initial-scale=1" />
  <meta name="theme-color" content="#000" />
  <title>akroncloud-slot · desktop VNC</title>
  <style>
    :root { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: #000; color: #e6edf3;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      overscroll-behavior: none;
    }
    #app { display: flex; flex-direction: column; height: 100dvh; height: 100vh; }

    #screen {
      flex: 1; min-height: 0;
      position: relative;
      background: #000;
      overflow: hidden;
      touch-action: none;
    }
    #screen > canvas { display: block; }

    #bar {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 8px;
      height: 32px;
      padding: 0 10px;
      background: #161b22;
      border-top: 1px solid #30363d;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    #bar .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #6e7681; flex-shrink: 0;
    }
    #bar .dot.ok  { background: #3fb950; }
    #bar .dot.err { background: #f85149; }
    #bar .stat { color: #8b949e; }
    #bar .stat b { color: #c9d1d9; font-weight: 500; }
    #bar button {
      background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 4px; padding: 2px 10px;
      font-size: 12px; cursor: pointer;
      font-family: inherit;
    }
    #bar button:hover  { background: #21262d; }
    #bar button:active { transform: translateY(1px); }
    #syncFab { position: fixed; right: 18px; bottom: 48px; z-index: 10;
      border: 0; border-radius: 999px; padding: 11px 16px; cursor: pointer;
      background: #238636; color: #fff; font-weight: 700; box-shadow: 0 4px 16px #0009; }
    #syncFab:disabled { opacity: .65; cursor: wait; }
  </style>
</head>
<body>
<div id="app">
  <div id="screen">
    <div id="placeholder">connecting…</div>
  </div>
  <button id="syncFab" type="button" title="Sincronizar la cuenta MT5 después de iniciar sesión">↻ Sincronizar MT5</button>
  <div id="bar">
    <span class="dot" id="dot"></span>
    <span class="stat" id="conn">disconnected</span>
    <span class="stat">· canvas: <b id="clicks">0</b></span>
    <span class="stat">· rfb: <b id="rfbClicks">0</b></span>
    <span class="stat">· last: <b id="last">—</b></span>
    <button id="reconnect" type="button" title="Reconnect WebSocket">↻</button>
  </div>
</div>

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');
const { default: MouseButtonMapper } = await import('/vnc-static/core/mousebuttonmapper.js');

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
const _origHandleMouse = RFB.prototype._handleMouse;
RFB.prototype._handleMouse = function (ev) {
  if (!this.mouseButtonMapper) {
    const m = new MouseButtonMapper();
    m.set(0, 1); m.set(1, 2); m.set(2, 3); m.set(3, 8); m.set(4, 9);
    this.mouseButtonMapper = m;
  }
  return _origHandleMouse.call(this, ev);
};

const screen = document.getElementById('screen');
const placeholder = document.getElementById('placeholder');
const dot = document.getElementById('dot');
const conn = document.getElementById('conn');
const clicksEl = document.getElementById('clicks');
const rfbClicksEl = document.getElementById('rfbClicks');
const lastEl = document.getElementById('last');
const syncFab = document.getElementById('syncFab');

// KasmVNC's RFB fork does not expose getCanvas(). The canvas is
// always the only <canvas> under #screen (we wipe screen.innerHTML
// before attaching RFB), so a querySelector is unambiguous. If RFB
// is connected this returns its canvas; otherwise null.
function getCanvas() {
  return screen.querySelector('canvas');
}

let rfb = null;
let connected = false;
let canvasClicks = 0;
let rfbClicks = 0;
let countersWired = false;

function setStatus(state, text) {
  dot.className = 'dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  conn.textContent = text;
}
function fmtLast(ev) {
  return ev.type + ' @ ' + Math.round(ev.clientX) + ',' + Math.round(ev.clientY);
}

function getUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/mt5-ws';
}

function disconnect() {
  if (rfb) {
    try { rfb.disconnect(); } catch (_) {}
    const c = getCanvas();
    if (c) try { c.remove(); } catch (_) {}
    rfb = null;
  }
  connected = false;
  countersWired = false;
  setStatus('', 'disconnected');
}

function connect() {
  disconnect();
  setStatus('', 'connecting…');
  placeholder.textContent = 'Connecting to KasmVNC…';
  placeholder.style.display = 'flex';

  screen.innerHTML = '';
  placeholder.remove();

  rfb = new RFB(screen, null, getUrl(), { background: '#000' }, true);

  rfb.resizeSession = false;
  rfb.scaleViewport = true;
  rfb.clipViewport = true;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;

  rfb.addEventListener('connect', () => {
    connected = true;
    setStatus('ok', 'connected — refreshing…');

    const canvas = getCanvas();
    if (canvas) {
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.margin = '0';
      // cursor:none because KasmVNC draws its own cursor inside the
      // framebuffer; without this the user sees two cursors that drift
      // out of sync and clicks look unresponsive even when MT5 is
      // receiving the events fine.
      canvas.style.cursor = 'none';
      canvas.tabIndex = 0;
      canvas.focus();
    }

    try { rfb._updateScale(); } catch (_) {}
    try {
      RFB.messages.fbUpdateRequest(
        rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight,
      );
    } catch (_) {}

    setTimeout(() => {
      // Re-pin focus after the framebuffer refresh settles — the
      // reattach cycle can drop it.
      const c = getCanvas();
      if (c && document.activeElement !== c) c.focus();
      setStatus('ok', 'connected ' + rfb._fbWidth + 'x' + rfb._fbHeight);
    }, 350);
  });

  // Wire the click counters once RFB has created its canvas (its
  // constructor does so synchronously, so a microtask is enough).
  function wireCounters() {
    if (countersWired) return;
    const c = getCanvas();
    if (!c) return;
    c.addEventListener('mousedown', () => {
      canvasClicks++;
      clicksEl.textContent = String(canvasClicks);
    });
    const onRfb = (ev) => {
      rfbClicks++;
      rfbClicksEl.textContent = String(rfbClicks);
      lastEl.textContent = fmtLast(ev);
    };
    c.addEventListener('mousedown', onRfb);
    c.addEventListener('mouseup',   onRfb);
    countersWired = true;
  }
  queueMicrotask(wireCounters);

  rfb.addEventListener('disconnect', (e) => {
    connected = false;
    const why = e?.detail?.reason ? ' — ' + e.detail.reason : '';
    setStatus('err', 'disconnected' + why);
  });

  // Re-apply canvas styling on resize — KasmVNC occasionally
  // re-inlines its own styles after the initial attach.
  const ro = new ResizeObserver(() => {
    const c = getCanvas();
    if (!c) return;
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.margin = '0';
    c.style.cursor = 'none';
  });
  ro.observe(screen);
}

document.getElementById('reconnect').addEventListener('click', () => {
  setTimeout(connect, 50);
});
syncFab.addEventListener('click', async () => {
  syncFab.disabled = true; syncFab.textContent = 'Sincronizando…';
  try {
    const r = await fetch('/internal/sync', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    syncFab.textContent = '✓ Sincronizado';
  } catch (_) { syncFab.textContent = '✕ Reintentar sync'; }
  setTimeout(() => { syncFab.disabled = false; syncFab.textContent = '↻ Sincronizar MT5'; }, 2200);
});

// window-level keydown → forward to the canvas so MT5 receives
// keystrokes regardless of which element currently has focus.
window.addEventListener('keydown', (ev) => {
  if (!connected || !rfb) return;
  const c = getCanvas();
  if (c && document.activeElement !== c) c.focus();
});

window.addEventListener('resize', () => {
  if (rfb) { try { rfb._updateScale(); } catch (_) {} }
});

connect();
</script>
</body>
</html>
`;
