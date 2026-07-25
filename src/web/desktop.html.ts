/**
 * /desktop — full-screen KasmVNC native client with a floating
 * action button overlay.
 *
 * Why the iframe approach instead of a custom RFB client:
 *   The KasmVNC native client (vnc-static/index.html) is the
 *   upstream-tested RFB client. Our custom RFB client in earlier
 *   versions of this file had a cosmetic issue that left the
 *   canvas blank in some browser/KasmVNC combinations (canvas
 *   dimensions not synchronized with the framebuffer update
 *   pipeline). The native client is known-good. We iframe it
 *   and overlay the FAB on top.
 *
 * Same-origin: the iframe loads /vnc-static/index.html from the
 * SAME origin as the parent (slot:7777), so the WebSocket
 * upgrade to /mt5-ws goes through the slot's proxy and auth
 * headers (BasicAuth from KasmVNC's auth pipe) work correctly.
 *
 * FAB actions go through the slot's REST API directly
 * (/v1/sync, /v1/accounts, etc.) and don't touch the iframe.
 * That keeps the FAB simple and avoids cross-origin issues.
 *
 * /mobile is unchanged (MOBILE_HTML in mobile.html.ts).
 */

export const DESKTOP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      background: #000;
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    /* The KasmVNC native client fills the viewport. */
    #vnc_frame {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      border: 0;
      z-index: 0;
    }

    /* Floating action button (bottom-right). Same UX as the /mobile
       wrapper: status dot + popover with broker login / resync /
       settings / reconnect actions. The actions go through the
       slot's REST API; for the "Broker login" we open our own
       credentials modal (the iframe is just the VNC viewport,
       we don't want to interact with it). */
    #fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 100;
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
    #fab .trigger .icon { font-size: 18px; line-height: 1; }
    #fab .menu {
      display: none;
      flex-direction: column;
      min-width: 220px;
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
    #fab .menu button:hover { background: #21262d; }
    #fab .menu button.primary {
      background: var(--accent); color: #fff;
    }
    #fab .menu .icon {
      width: 16px; text-align: center; font-size: 14px; flex-shrink: 0;
    }
    #fab .menu .label { flex: 1; }

    /* Credentials modal: same one-tap broker fill as /mobile. */
    #credsheet {
      position: fixed; inset: 0; background: rgba(0,0,0,.7);
      display: none; align-items: center; justify-content: center;
      z-index: 200; padding: 16px;
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
  </style>
</head>
<body>
<iframe id="vnc_frame" src="/vnc-static/index.html" allow="clipboard-read; clipboard-write"></iframe>

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
  </form>
</div>

<script>
const $ = (id) => document.getElementById(id);
const fab = $('fab');
const fabStatus = $('fab_status');

// FAB trigger: toggle popover
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

// Status: poll /v1/health every 2s and color the dot accordingly.
async function refreshStatus() {
  try {
    const r = await fetch('/v1/health', { cache: 'no-store' });
    if (!r.ok) throw new Error('health ' + r.status);
    const j = await r.json();
    const conn = j.connector && j.connector === 'mt5';
    const mt5 = j.mt5 || {};
    const cmdOk = mt5.cmd_port_state === 'listening';
    const cls = (cmdOk && conn) ? 'ok' : (j.status === 'ok' ? 'ok' : 'err');
    fabStatus.className = 'status ' + (cls === 'ok' ? 'ok' : 'err');
  } catch (e) {
    fabStatus.className = 'status err';
  }
}
refreshStatus();
setInterval(refreshStatus, 2000);

// FAB actions
$('fab_sync').addEventListener('click', async () => {
  fab.classList.remove('open');
  try {
    const r = await fetch('/v1/sync', { method: 'POST' });
    fabStatus.className = 'status ' + (r.ok ? 'ok' : 'err');
  } catch (e) {
    fabStatus.className = 'status err';
  }
});
$('fab_reconnect').addEventListener('click', () => {
  fab.classList.remove('open');
  // Reload the iframe — the KasmVNC client reconnects on its own.
  const f = $('vnc_frame');
  f.src = f.src.split('?')[0] + '?cachebust=' + Date.now();
});

// Broker login modal (FAB action)
const CREDS_KEY = 'akron-broker-creds';
const creds = JSON.parse(localStorage.getItem(CREDS_KEY) || 'null');
$('fab_login').addEventListener('click', () => {
  fab.classList.remove('open');
  $('f_server').value = creds?.server || '';
  $('f_login').value = creds?.login || '';
  $('f_password').value = creds?.password || '';
  $('f_investor').value = creds?.investor || '';
  $('credsheet').classList.add('open');
  setTimeout(() => $('f_server').focus(), 50);
});
$('credcancel').addEventListener('click', () => $('credsheet').classList.remove('open'));
$('credform').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = {
    server: $('f_server').value.trim(),
    login: $('f_login').value.trim(),
    password: $('f_password').value,
    investor: $('f_investor').value,
  };
  localStorage.setItem(CREDS_KEY, JSON.stringify(c));
  $('credsheet').classList.remove('open');
  // Fill by clicking through the iframe's input fields. We can't
  // reach into the same-origin iframe from outside, so the user has
  // to click into the MT5 GUI manually and use the auto-fill.
  // (The creds are saved and can be pasted via the kclient's
  // clipboard-sync. The /mobile flow uses rfb.sendKey against the
  // RFB client to automate; here we don't have an RFB handle so
  // the user pastes manually.)
  alert('Credenciales guardadas. Pegalas en el formulario de login del MT5 (clic en el servidor, login, password y Ctrl+V).');
});
</script>
</body>
</html>
`;
