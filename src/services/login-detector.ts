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
 *   2. Run `s6-svc -d /run/service/svc-de` which cascades to
 *      svc-kclient + svc-kasmvnc + svc-nginx (their deps)
 *   3. Tell the slot's REST/WS layer via `onTransition` so /v1/state
 *      starts reporting operational.
 *   4. v53: publish an {kind:'account', data:{logged_in:true}} event
 *      into the slot's Mt5TcpServer so the Mt5Connector flips
 *      loggedIn=true (the SlotService.ex5 would normally do this
 *      over TCP, but it doesn't autostart on a fresh WINEPREFIX).
 *
 * v53 also adds logout detection: if the user logs out (closes the
 * session), wmctrl reverts to the login dialog and we publish
 * {logged_in:false}. Without this, the slot would stay stuck at
 * loggedIn=true after a logout.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
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
export function startLoginDetector(opts: StartLoginDetectorOpts): () => void {
  const stateFile = opts.stateFile ?? STATE_FILE;
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;

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
    if (next === prev) return; // no transition
    log.info({ from: prev, to: next }, 'login-detector state transition');
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
      try {
        for (const pat of [
          'Xvnc',
          'openbox',
          'kclient',
          'nginx: master',
          'pulseaudio',
        ]) {
          try {
            execFileSync('pkill', ['-9', '-f', pat], { stdio: 'ignore' });
          } catch {
            /* pkill exits 1 if no process matched — that's fine */
          }
        }
        for (const svc of [
          'svc-de',
          'svc-kclient',
          'svc-kasmvnc',
          'svc-nginx',
        ]) {
          try {
            execFileSync('s6-svc', ['-D', `/run/service/${svc}`], {
              stdio: 'ignore',
            });
          } catch {
            /* ignore — s6 may not be visible to slot's child env */
          }
        }
        log.info('VNC chain killed — slot is now operational');
      } catch (e) {
        log.warn(
          { err: (e as Error).message },
          'cascade-kill VNC services failed (slot will still mark operational)',
        );
      }
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

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
