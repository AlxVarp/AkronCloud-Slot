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
 */
import { execFile, spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { log } from '../log.js';

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
    });
    const lines = stdout.split('\n').filter((l) => l.trim());
    let mt5Windows = 0;
    for (const line of lines) {
      // wmctrl -l output: "<window-id> <desktop> <host> <pid> <class> <title>..."
      // wmctrl -lx adds WM_CLASS, so fields shift. Be permissive.
      const m = line.match(/^\s*0x\w+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const wmClass = m[1] ?? '';
      const title = (m[2] ?? '').trim();
      if (!/^terminal64\.exe$/i.test(wmClass)) continue;
      mt5Windows++;
      // Pre-login: title is "Login" or "MetaTrader 5 - Login".
      // Post-login: title has the broker + account + style + company.
      if (!title) continue;
      if (/^Login$/i.test(title)) return false;
      if (/Login to |Login :|MetaTrader 5 - Login\b/i.test(title)) return false;
      if (title.includes(':')) return true; // broker:account pattern
    }
    // Fallback: if there are 3+ MT5 windows (chart, market watch,
    // toolbox) and none is the login dialog, treat as logged in.
    return mt5Windows >= 3;
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
  let triggered = false;

  // If the slot is already operational, skip the watcher.
  if (readSlotState(stateFile) === 'operational') {
    log.info(
      'slot already operational on boot — login detector idle',
    );
    void opts.onTransition();
    return () => {
      stopped = true;
    };
  }

  const tick = async (): Promise<void> => {
    if (stopped || triggered) return;
    if (readSlotState() === 'operational') {
      triggered = true;
      log.info('state already operational — exiting detector loop');
      return;
    }
    const ok = await isLoggedIn();
    if (ok) {
      triggered = true;
      try {
        writeFileSync(stateFile, 'operational\n', { mode: 0o600 });
      } catch (e) {
        log.error(
          { err: (e as Error).message },
          'failed to write state file',
        );
        triggered = false; // try again next tick
        return;
      }
      log.info(
        'MT5 login detected — transitioning slot to operational',
      );
      try {
        // Cascade-kill the VNC chain. svc-de's deps include
        // svc-kclient + svc-kasmvnc + svc-nginx, so killing -de
        // takes down the VNC + nginx-front automatically.
        const s6svc = spawn('s6-svc', ['-d', '/run/service/svc-de'], {
          stdio: 'ignore',
          detached: true,
        });
        s6svc.unref();
      } catch (e) {
        log.warn(
          { err: (e as Error).message },
          's6-svc -d svc-de failed (slot will still mark operational)',
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
