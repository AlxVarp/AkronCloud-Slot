/**
 * /desktop — minimal desktop VNC wrapper for KasmVNC.
 *
 * debug/ea-minimal branch. The previous wrapper carried a FAB, a
 * credentials sheet, a top status bar, and a forced 1024x768
 * letterbox fit. None of that helps us debug the SlotService
 * question — it just adds CSS layers between the user's click and
 * the RFB canvas. This version is the smallest possible surface:
 *
 *   - one full-viewport canvas, no overlays
 *   - one row at the bottom with status text + a reconnect button
 *     (so the operator can recover if the WS drops)
 *   - the RFB plumbing is copied verbatim from /mobile (which is
 *     the proven-working template) minus the mobile-only resolution
 *     forcing and the virtual keyboard
 *
 * If the user's clicks don't reach MT5 here, the issue is in the
 * RFB client / Xvnc / MT5 layer, not in our wrapper — which is
 * exactly the question we're trying to answer.
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

    /* The screen takes ALL remaining space. No letterbox, no FAB,
       no toolbar in the middle. The MT5 canvas fills it edge to edge;
       we let the browser scale the 1024x768 framebuffer down to the
       viewport on its own (RFB's default scaleViewport=true). */
    #screen {
      flex: 1; min-height: 0;
      position: relative;
      background: #000;
      overflow: hidden;
      touch-action: none;
    }
    /* KasmVNC's RFB fork inlines display:flex; margin:auto on the
       canvas via its constructor. Without an override, the canvas
       can collapse to 0x0 inside an ancestor flex container; the
       JS override below pins it to fill the screen. */
    #screen > canvas { display: block; }

    #placeholder {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #6e7681; font-size: 13px;
      pointer-events: none;
    }

    /* Minimal bottom strip. One status dot, one status text, one
       reconnect button. No FAB, no menu, no sync button — we don't
       even hit /v1/sync from here because that hides the real issue
       (the EA) behind a successful-looking sync. */
    #bar {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 8px;
      height: 28px;
      padding: 0 10px;
      background: #161b22;
      border-top: 1px solid #30363d;
      font-size: 12px;
    }
    #bar .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #6e7681; flex-shrink: 0;
    }
    #bar .dot.ok  { background: #3fb950; }
    #bar .dot.err { background: #f85149; }
    #bar .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b949e; }
    #bar button {
      background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 4px; padding: 2px 10px;
      font-size: 12px; cursor: pointer;
    }
    #bar button:hover  { background: #21262d; }
    #bar button:active { transform: translateY(1px); }
  </style>
</head>
<body>
<div id="app">
  <div id="screen">
    <div id="placeholder">connecting…</div>
  </div>
  <div id="bar">
    <span class="dot" id="dot"></span>
    <span class="label" id="label">disconnected</span>
    <button id="reconnect" type="button" title="Reconnect WebSocket">↻</button>
  </div>
</div>

<script type="module">
const { default: RFB } = await import('/vnc-static/core/rfb.js');
const { default: MouseButtonMapper } = await import('/vnc-static/core/mousebuttonmapper.js');

// Same prototype patches mobile.html.ts uses — verified-necessary
// for the KasmVNC RFB fork (UnixRelaySub drain, mouseButtonMapper
// lazy init). Skipping them here just to "be minimal" would
// re-introduce the exact bug we already fixed once.
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
const label = document.getElementById('label');

let rfb = null;
let connected = false;

function setStatus(state, text) {
  dot.className = 'dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  label.textContent = text;
}

function getUrl() {
  // ws URL is built off location so the same wrapper works whether
  // the slot is fronted by nginx, behind a tunnel, or hit via the
  // raw 7777 port.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/mt5-ws';
}

function disconnect() {
  if (rfb) {
    try { rfb.disconnect(); } catch (_) {}
    try { rfb.getCanvas()?.remove(); } catch (_) {}
    rfb = null;
  }
  connected = false;
  setStatus('', 'disconnected');
}

function connect() {
  disconnect();
  setStatus('', 'connecting…');
  placeholder.textContent = 'Connecting to KasmVNC…';
  placeholder.style.display = 'flex';

  // Clear placeholder so RFB's wrapper div + canvas become the only
  // children of #screen. Same fix as mobile.html.ts.
  screen.innerHTML = '';
  placeholder.remove();

  rfb = new RFB(screen, null, getUrl(), { background: '#000' }, true);

  // Same perf settings as mobile.html.ts (proven to work for the
  // 414x440 viewport; for 1024x768 they reduce per-frame bytes
  // ~3-5x by preferring Tight/ZRLE over Raw rectangles).
  rfb.resizeSession = false;
  rfb.scaleViewport = true;
  rfb.clipViewport = true;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;

  rfb.addEventListener('connect', () => {
    connected = true;
    setStatus('ok', 'connected — refreshing framebuffer…');
    placeholder.style.display = 'none';
    // Same fit() as mobile.html.ts — _updateScale +
    // fbUpdateRequest + applyCanvasCentering. KasmVNC does not push
    // a framebuffer update on its own after the handshake, so the
    // canvas would stay black without this.
    try { rfb._updateScale(); } catch (_) {}
    try {
      RFB.messages.fbUpdateRequest(
        rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight,
      );
    } catch (_) {}
    setTimeout(() => setStatus('ok', 'connected (' + rfb._fbWidth + 'x' + rfb._fbHeight + ')'), 350);
  });
  rfb.addEventListener('disconnect', (e) => {
    connected = false;
    const why = e?.detail?.reason ? ' — ' + e.detail.reason : '';
    setStatus('err', 'disconnected' + why);
  });

  // Re-apply canvas centering after every layout change. The
  // KasmVNC fork inlines display:flex + margin:auto on the canvas,
  // which can collapse it inside the wrapper div. We pin it to
  // fill its parent.
  function fixCanvas() {
    const canvas = screen.querySelector('canvas');
    if (!canvas) return;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.margin = '0';
  }
  const ro = new ResizeObserver(fixCanvas);
  ro.observe(screen);
  setInterval(fixCanvas, 1000);
  setTimeout(fixCanvas, 100);
}

document.getElementById('reconnect').addEventListener('click', () => {
  setTimeout(connect, 50);
});

window.addEventListener('resize', () => {
  if (rfb) {
    try { rfb._updateScale(); } catch (_) {}
  }
});

connect();
</script>
</body>
</html>
`;