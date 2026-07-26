/**
 * /desktop — minimal desktop VNC wrapper for KasmVNC.
 *
 * debug/ea-minimal branch, v3. v1 added the prototype patches from
 * /mobile and the proven perf settings. v2 stripped the wrapper
 * down to canvas + status bar + reconnect. v3 (this) adds three
 * things we need to figure out whether clicks reach MT5:
 *
 *   1. tabindex="0" on the canvas + explicit .focus() on connect.
 *      Without this, the canvas (tabIndex=-1) is focusable but
 *      Chromium-based browsers won't route key events through it
 *      until something else (the mousedown → focusCanvas chain)
 *      primes focus — and on a brand-new RFB connection that
 *      priming hasn't happened yet.
 *
 *   2. cursor:none on the canvas. KasmVNC's bundled UI hides the
 *      browser cursor and draws its own via _cursor.js. Without
 *      this the user sees two cursors (their OS one + MT5's) which
 *      makes it look like "nothing responds" when in fact MT5 is
 *      receiving events just fine.
 *
 *   3. A click counter on the status bar that ticks every time the
 *      canvas's own mousedown listener fires AND every time the
 *      RFB client's _handleMouse runs. If the canvas counter ticks
 *      but the RFB counter doesn't, the event is reaching the DOM
 *      but not the RFB client. If both tick but MT5 doesn't react,
 *      the wire is broken further down.
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
  </style>
</head>
<body>
<div id="app">
  <div id="screen">
    <div id="placeholder">connecting…</div>
  </div>
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

let rfb = null;
let connected = false;
let canvasClicks = 0;
let rfbClicks = 0;

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

    // Pin the canvas to fill #screen and pull its native cursor out
    // of the way (KasmVNC draws its own cursor via _cursor.js — when
    // the browser cursor is also visible the user sees a doubled
    // cursor that makes clicks look unresponsive).
    const canvas = rfb.getCanvas();
    if (canvas) {
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.margin = '0';
      canvas.style.cursor = 'none';
      canvas.tabIndex = 0;
      canvas.addEventListener('mousedown', () => {
        canvasClicks++;
        clicksEl.textContent = String(canvasClicks);
      });
      // Prime keyboard focus immediately — Chromium needs the canvas
      // focused before it routes key events into _handleKey. Without
      // this the first keystroke after connect is dropped.
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
      const c = rfb.getCanvas();
      if (c && document.activeElement !== c) c.focus();
      setStatus('ok', 'connected ' + rfb._fbWidth + 'x' + rfb._fbHeight);
    }, 350);
  });

  // Wrap _handleMouse so we can count how many mouse events RFB
  // actually received (regardless of whether they were forwarded
  // to VNC). If canvasClicks ticks but rfbClicks doesn't, the
  // browser is firing on the canvas but RFB's listener isn't
  // catching it — usually a CSS overlay eating the events.
  const _wrappedHandle = function (ev) {
    rfbClicks++;
    rfbClicksEl.textContent = String(rfbClicks);
    lastEl.textContent = fmtLast(ev);
  };
  // Attach our own click listener on the same canvas AFTER RFB does
  // (RFB's is added in its constructor). Since both fire on the
  // same element, order only matters for which runs first, not
  // whether both fire.
  const wireCounters = () => {
    const c = rfb && rfb.getCanvas();
    if (!c || c.__countersWired) return;
    c.addEventListener('mousedown', _wrappedHandle);
    c.addEventListener('mouseup',   _wrappedHandle);
    c.__countersWired = true;
  };

  rfb.addEventListener('disconnect', (e) => {
    connected = false;
    const why = e?.detail?.reason ? ' — ' + e.detail.reason : '';
    setStatus('err', 'disconnected' + why);
  });

  // wireCounters after a microtask so RFB's constructor has added
  // its listeners (it creates the canvas synchronously, so this is
  // safe immediately; the defer is just paranoia).
  queueMicrotask(wireCounters);

  const ro = new ResizeObserver(() => {
    const c = rfb && rfb.getCanvas();
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

// window-level keydown → forward to the canvas so MT5 receives
// keystrokes regardless of which element currently has focus.
window.addEventListener('keydown', (ev) => {
  if (!connected || !rfb) return;
  const c = rfb.getCanvas();
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