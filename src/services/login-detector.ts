/**
 * login-detector — watches the running MetaTrader 5 instance via
 * `wmctrl -l` and detects when the user has finished logging in.
 *
 * Detection heuristic: MT5's window title is
 *   * "Login" (or "Autorisation" / etc.) before login
 *   * "<Broker>: <Account> - <Style> - <Company>" after login
 *
 * So we look for any window owned by the running terminal64.exe whose
 * title is non-empty AND does not start with the strings the login
 * screen uses. We also require MT5 to have at least three top-level
 * windows (login screen has one) — that's the second signal.
 *
 * When we decide the user is logged in:
 *   1. Write /var/lib/akron-slot/state = "operational"
 *   2. Tell the slot's REST/WS layer via `onTransition` so /v1/state
 *      starts reporting operational.
 *   3. v53: publish an {kind:'account', data:{logged_in:true}} event
 *      into the slot's Mt5TcpServer so the Mt5Connector flips
 *      loggedIn=true (the SlotService.ex5 would normally do this
 *      over TCP, but it doesn't autostart on a fresh WINEPREFIX).
 *   4. v54: publish account balance/equity/login/server when the
 *      Python account-publisher (running in wine) starts pushing them
 *      over TCP 7778. The Python side uses `MetaTrader5.initialize()`
 *      + `mt5.account_info()`, so the slot learns about MT5 state
 *      without SlotService.ex5 needing to autostart.
 *
 * v53 also adds logout detection: if the user logs out (closes the
 * session), wmctrl reverts to the login dialog and we publish
 * {logged_in:false}. Without this, the slot would stay stuck at
 * loggedIn=true after a logout.
 *
 * v54 REMOVES the post-login cascade-kill of the VNC chain. The
 * original code did `pkill Xvnc; pkill openbox; ...; s6-svc -D
 * svc-de svc-kclient svc-kasmvnc svc-nginx` after detecting login.
 * Rationale at the time was "save resources once operational" —
 * but in practice MT5 (terminal64.exe) dies shortly after Xvnc goes
 * down because it loses its X display. With MT5 dead, the
 * MetaTrader5 Python package's `account_info()` always returns
 * None, so the Python account-publisher (v54) has nothing to
 * publish and `/v1/state` reports `balance: 0, equity: 0` even
 * after the user is logged in. The cascade-kill was reverted to
 * allow MT5 to outlive the VNC session and keep its display. The
 * resource cost of keeping Xvnc alive post-login is acceptable
 * (KasmVNC is ~50 MB RSS idle); if this becomes a problem on small
 * VPSes we can revisit (e.g. switch MT5 to xvfb-run headless once
 * `mt5.initialize()` is proven to work without a real display).
 */
import { execFile } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { log } from '../log.js';
import type { Mt5TcpServer } from './mt5-tcp-server.js';

const execFileP = promisify(execFile);

const STATE_FILE = '/var/lib/akron-slot/state';
const POLL_INTERVAL_MS = 1500;

export type LoginCallback = () => Promise<void> | void;

/**
 * Returns true if any wmctrl window matches the "logged in" pattern:
 *   - title doesn't contain "Login" (the login modal title)
 *   - title is non-empty and not just whitespace
 *   - title contains ":" (the post-login "Broker: Account" pattern)
 *
 * We're defensive about wmctrl's exact output format across X servers.
 */
async function isLoggedIn(): Promise<boolean> {
  try {
    const { stdout } = await execFileP('wmctrl', ['-lx'], {
      timeout: 2000,
      env: { ...process.env, DISPLAY: ':0' },
    });
    const lines = stdout.split('\n').filter((l) => l.trim());
    let mt5Windows = 0;
    for (const line of lines) {
      // wmctrl -lx with default 1-space separators: <id> <desktop>
      // <instance.class> <host> <title words...>. The 3rd field has a
      // dot in it (instance.class) but no spaces. After splitting on
      // \s+, the title becomes multiple parts; we rejoin them.
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const wmClass = parts[2] ?? '';
      const title = parts.slice(4).join(' ').trim();
      if (!/terminal64\.exe/i.test(wmClass)) continue;
      mt5Windows++;
      if (!title) continue;
      // Pre-login: "Login" or "MetaTrader 5 - Login"
      if (/^Login\b|^MetaTrader 5 - Login\b|^\s*Login\s*$/i.test(title)) {
        return false;
      }
      // Post-login: any of these patterns
      if (/^MetaTrader 5/.test(title)) return true; // "MetaTrader 5", "MetaTrader 5 - ...", "MetaTrader 5 - Login" excluded above
      if (title.includes(':')) return true; // "Broker: Account - ..."
      if (/^Account:\s/i.test(title)) return true; // "Account: <login>"
    }
    // Fallback: 2+ MT5 windows and none looks like a login dialog
    if (mt5Windows >= 2) return true;
    return false;
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'isLoggedIn probe failed');
    return false;
  }
}

export function readSlotState(
  stateFile: string = STATE_FILE,
): 'pending_login' | 'operational' | 'unknown' {
  try {
    if (!existsSync(stateFile)) return 'pending_login';
    const txt = readFileSync(stateFile, 'utf8').trim();
    if (txt === 'operational') return 'operational';
    if (txt === 'pending_login') return 'pending_login';
    return 'unknown';
  } catch {
    return 'pending_login';
  }
}

export type StartLoginDetectorOpts = {
  onTransition: LoginCallback;
  /**
   * v53: the slot's MT5 TCP server. When the detector sees a login
   * transition (logged_out → logged_in, or vice versa) it calls
   * `tcp.publish({type:'event', kind:'account', data:{logged_in:...}})`
   * so the Mt5Connector flips loggedIn on its per-account record.
   * Optional: pass undefined in dev (no MT5) and the detector is a no-op.
   */
  tcp?: Pick<Mt5TcpServer, 'publish'>;
  /** Override the state file path (mostly for tests). */
  stateFile?: string;
  /** Override poll interval (mostly for tests). */
  intervalMs?: number;
};

/**
 * Starts the detector. Returns a stop() function. Idempotent — calling
 * start() twice on a slot that's already operational is a no-op.
 */
export function startLoginDetector(opts: StartLoginDetectorOpts): { stop: () => void; refresh: () => Promise<void> } {
  const stateFile = opts.stateFile ?? STATE_FILE;
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;

  // v0.4-trading-api-fix: expose a refresh() handle so the rest of the
  // slot can re-trigger a fresh wmctrl poll after an account is
  // registered. The race otherwise is:
  //   boot: state file says "operational" → detector publishes
  //   logged_in:true once. accounts Map is empty → handleEvent drops
  //   it. /v1/sync registers the account → no new publish fires (the
  //   detector thinks user is already logged_in) → /v1/state shows
  //   loggedIn:false forever. refresh() breaks the stalemate by
  //   forcing a re-evaluation; if MT5 is still logged in (the
  //   wmctrl-detected state hasn't changed) tick() will see "logged_in"
  //   → "logged_in" and skip the publish, BUT we publish anyway via
  //   forcePublish=true so the new account record gets populated.
  let forcePublish = false;

  let stopped = false;
  // v53: track login state as a state machine (logged_out /
  // logging_in / logged_in) so the detector can fire both
  // transitions and so a logout also publishes {logged_in:false}.
  let prev: 'unknown' | 'logged_out' | 'logged_in' = 'unknown';

  // Initial state: if the slot is already operational, treat that
  // as the boot-time state and start the loop. We don't kill VNC on
  // boot — that's the one-time transition the original code handled.
  if (readSlotState(stateFile) === 'operational') {
    prev = 'logged_in';
    if (opts.tcp) {
      opts.tcp.publish({
        type: 'event',
        kind: 'account',
        data: { logged_in: true },
      });
    }
    void opts.onTransition();
  }

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = await isLoggedIn();
    const next: 'logged_out' | 'logged_in' = now ? 'logged_in' : 'logged_out';
    if (next === prev && !forcePublish) return; // no transition
    const wasForce = forcePublish;
    forcePublish = false;
    log.info(
      { from: prev, to: next, force: wasForce },
      wasForce ? 'login-detector forced re-publish' : 'login-detector state transition',
    );
    prev = next;
    if (next === 'logged_in') {
      // First-time login (or login after a logout): write state file,
      // kill the VNC chain, fire onTransition, publish account event.
      try {
        writeFileSync(stateFile, 'operational\n', { mode: 0o600 });
      } catch (e) {
        log.error(
          { err: (e as Error).message },
          'failed to write state file',
        );
        return;
      }
      log.info('MT5 login detected — transitioning slot to operational');
      // v54: cascade-kill of the VNC chain removed. See the file header
      // for why — killing Xvnc/openbox took MT5's X display with it,
      // so `mt5.account_info()` from the Python account-publisher
      // always returned None (MT5 was dead). The slot now leaves
      // svc-de/svc-kclient/svc-kasmvnc/svc-nginx running so MT5 keeps
      // its display and the Python side can read account_info().
      try {
        await opts.onTransition();
      } catch (e) {
        log.error(
          { err: (e as Error).message },
          'onTransition callback failed',
        );
      }
      if (opts.tcp) {
        opts.tcp.publish({
          type: 'event',
          kind: 'account',
          data: { logged_in: true },
        });
      }
    } else {
      // Logout: write the state file back to pending_login so a
      // re-login re-runs the cascade. Publish {logged_in:false} so
      // /v1/state flips back.
      log.info('MT5 logout detected — slot returning to pending_login');
      try {
        writeFileSync(stateFile, 'pending_login\n', { mode: 0o600 });
      } catch (e) {
        log.error(
          { err: (e as Error).message },
          'failed to write state file on logout',
        );
      }
      if (opts.tcp) {
        opts.tcp.publish({
          type: 'event',
          kind: 'account',
          data: { logged_in: false },
        });
      }
    }
  };

  const handle = setInterval(() => {
    void tick().catch((e) =>
      log.error({ err: (e as Error).message }, 'login-detector tick error'),
    );
  }, interval);
  // First tick fast — don't wait intervalMs the first time.
  setImmediate(() => {
    void tick().catch(() => {});
  });

  /**
   * Trigger an immediate re-publish of the current login state. Used by
   * Mt5Connector.connect() after registering an account so the new
   * account record picks up loggedIn:true from MT5 (which has been
   * logged in since before the slot restart).
   *
   * Returns a promise that resolves when the tick completes.
   */
  const refresh = (): Promise<void> => {
    forcePublish = true;
    return new Promise<void>((resolve) => {
      // Schedule a microtask so the next tick runs before resolve fires;
      // we use the existing setInterval tick path to keep ordering
      // identical. If there's already a tick in flight, just resolve on
      // its completion via a queued setImmediate.
      setImmediate(() => {
        tick()
          .catch((e) =>
            log.error(
              { err: (e as Error).message },
              'login-detector refresh tick error',
            ),
          )
          .finally(() => resolve());
      });
    });
  };

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    refresh,
  };
}
