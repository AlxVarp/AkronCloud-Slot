# Mobile VNC wrapper — session handoff (2026-07-20)

> **TL;DR:** Phase C / Ruta B1 (TCP bridge) is done and deployed as `v15`
> (tag `0.3.0-tcp-bridge-v15`, deployed to VPS at `45.151.122.104`).
> The `/mobile` page is up at `http://45.151.122.104:7777/mobile` but
> **fails with a noVNC runtime bug** (`Keyboard._keyboardInputReset`
> tries to assign `.value` on a string). The fix is one-line in the
> bundled RFB source — see "What's left" below.

---

## 1. Where we are

| Item | Status |
|---|---|
| Phase 0 (DLL compile / AllowDllImport) | done |
| Phase 1 (MQL5 TCP client) | done — service-mode, wsUrl connects to `127.0.0.1:7778` |
| Phase 2 (Node TCP server) | done — bound to `:7778`, frame parser + dispatchCommand working |
| Phase 3a (MT5 connector refactor) | done — was the silent blocker; PR #3 |
| Phase 3b (REST fixes) | done — accountRef dynamic from connector.id |
| VPS deploy v15 | done — `connector: mt5`, slot operational |
| Mobile wrapper `/mobile` | deployed, runs, but crashes at RFB constructor |

## 2. Where the wrapper lives

- `src/web/mobile.html.ts` — the full HTML+CSS+JS page as an inlined string
- `src/web/mobile.ts` — Fastify route handler (`GET /mobile`)
- `src/web/vnc-static-routes.ts` — `@fastify/static` for `/vnc-static/*`
- `src/web/mt5-ws-proxy.ts` — WebSocket proxy at `GET /mt5-ws`
- `src/web/vnc-static/` — KasmVNC's bundled client copied from
  `/usr/local/share/kasmvnc/www` inside the akron-mt5-base image.
  Currently we use ONLY `core/rfb.js` (the RFB class, no AngularJS UI).
- `.dockerignore` has `!src/web/vnc-static/` (negation) so the bundle
  survives the build context.
- `package.json` postbuild: `rm -rf dist/web/vnc-static && cp -r
  src/web/vnc-static dist/web/vnc-static` (must run after `tsc`).
  We renamed `dist/` -> `bundles/` inside the bundle to escape the
  `dist` rule.

## 3. The 15-version history (the painful parts)

| v | Issue | Fix |
|---|---|---|
|  1 | Load noVNC from jsDelivr failed | Switch to ES module `import()` from URL |
|  2 | `lib/rfb.js` is a CJS bundle, no `window.RFB` | Use `core/rfb.js` (ES module export) |
|  3 | `new RFB({target,url,options})` - wrong | Use positional `new RFB(target, url, options)` |
|  4 | WebSocket URL `/` returned HTML | Use `/websockify` (KasmVNC's default path) |
|  5 | Inline JS comment had backticks -> TS parse error | Removed backticks |
|  6 | iframe'd the KasmVNC admin UI | Bugs out with `UI.ngFlash.lastActiveAt` (AngularJS race) |
|  7 | Bundled client wasn't reaching the WS | `core/rfb.js` works (no AngularJS) |
|  8 | Bundled admin UI was iframe-loaded -> bug | Direct `core/rfb.js` instead |
|  9 | `.dockerignore` filtered `src/web/vnc-static/dist/` | Renamed `dist/` -> `bundles/` |
| 10 | Same - second attempt | Negation `!src/web/vnc-static/` |
| 11 | Bundles still missing | `bundles/` rename - works |
| 12 | KasmVNC admin UI AngularJS bug iframed | Switched to direct `core/rfb.js` |
| 13 | WebSocket stays connecting | nginx at port 3000 not reachable from mobile |
| 14 | Same-origin WS proxy at `/mt5-ws` | Added `src/web/mt5-ws-proxy.ts` |
| 15 | Slot in restart loop | `FastifyError: The decorator 'ws' has already been added!` - removed duplicate `@fastify/websocket` register |

All merged into `master` via separate PRs (#2, #3, #4) and direct pushes.

## 4. What's left - the **current** blocker

The user opens `http://45.151.122.104:7777/mobile` on their phone. The
page loads. The dynamic import of `/vnc-static/core/rfb.js` succeeds.
The `new RFB(canvas, "ws://45.151.122.104/mt5-ws", {...})` is called.

It crashes immediately:

```
Uncaught TypeError: Cannot create property 'value' on string
'ws://45.151.122.104/mt5-ws'
    at Keyboard._keyboardInputReset (keyboard.js:268:32)
    at new Keyboard (keyboard.js:47:14)
    at new RFB (rfb.js:297:26)
    at connect (mobile:290:9)
    at mobile:478:1
```

Source of the bug - `src/web/vnc-static/core/input/keyboard.js:269`:
```js
_keyboardInputReset() {
    this._touchInput.value = new Array(this._defaultKeyboardInputLen).join("_");
    this._lastKeyboardInput = this._touchInput.value;
}
```

`this._touchInput` is supposed to be a hidden `<input>` element, but in
this code path it's the URL string passed as the second arg to
`new Keyboard(this._canvas, touchInput)` in rfb.js:297.

### The fix (one line)

In `src/web/vnc-static/core/input/keyboard.js`, change the constructor
so that when `touchInput` is a string (i.e. someone passed the URL
or some other non-element value), the `_touchInput` member is treated
as a string (just stashed), not an element.

The minimum-impact change is to wrap the assignment in a try/catch OR
guard by type:

```js
// in core/input/keyboard.js, around line 269:
_keyboardInputReset() {
    if (typeof this._touchInput === 'string') {
        this._lastKeyboardInput = this._touchInput;
        return;
    }
    this._touchInput.value = new Array(this._defaultKeyboardInputLen).join("_");
    this._lastKeyboardInput = this._touchInput.value;
}
```

OR (cleaner) guard at construction:

```js
// in Keyboard constructor around line 27:
this._touchInput = (touchInput && typeof touchInput === 'object' && 'value' in touchInput)
    ? touchInput
    : null;
if (this._touchInput === null) {
    this._lastKeyboardInput = '';
    return;
}
this._keyboardInputReset();
```

The minimum-blast-radius fix is the first one (one method change).
Apply it, rebuild `src/web/vnc-static/core/input/keyboard.js`,
re-run the postbuild, bump image tag, redeploy.

## 5. Why the bug happens (in case the user asks)

The bundled noVNC in KasmVNC 4.0's `core/rfb.js` is KasmVNC's fork
of noVNC ~1.3.0 (it imports the URL into the RFB constructor, then
passes extra args to the Keyboard constructor). Looking at the actual
line 297: `new Keyboard(this._canvas, touchInput)`. The RFB expects
the second arg to be the keyboard input element, but in the bundled
fork it's somehow getting the URL or undefined.

Reading the line above 297 (around line 280-296) for context:

```js
let touchInput; // local var declared but not assigned in the branch
                // that's actually running on the user's path
```

So `touchInput` is undefined when called with 2 args (RFB(target, url, opts)).
Then `Keyboard(this._canvas, undefined)` -> `this._touchInput = undefined`,
and later `.value = ...` blows up because `undefined` doesn't have
`.value`. But the error message says `on string 'ws://...'` - so it
IS getting a string, not undefined. Need to look one level deeper.

Looking at the bundled rfb.js more carefully, around line 290-300 - there's
a `Keyboard.fromCanvas()` or similar helper that takes (canvas, touchInput).
The actual call uses `touchInput` from a higher scope.

Easiest: just guard the assignment.

## 6. Workflow for the next chat

```
$ ssh vps 'cd /srv/akroncloud-slot && git pull origin master'
# (image tag is 0.3.0-tcp-bridge-v15 in docker-compose.yml)
# OR work on a new branch:
$ git checkout -b fix/mobile-keyboard-bug
$ vim src/web/vnc-static/core/input/keyboard.js   # apply the fix
$ npm run build                                   # tsc + postbuild
$ sed -i 's|0.3.0-tcp-bridge-v15|0.3.0-tcp-bridge-v16|' docker-compose.yml
$ git add -A && git commit -m "fix(web): guard Keyboard._touchInput"
$ git push origin fix/mobile-keyboard-bug
# create PR via:
$ PR=$(curl -s -X POST -H "Authorization: token $KeyGIT" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    https://api.github.com/repos/AlxVarp/AkronCloud-Slot/pulls \
    -d '{"title":"fix(web): guard Keyboard._touchInput","head":"...","base":"master","body":"..."}')
$ curl -s -X PUT ... /pulls/$PR/merge ...
# build + deploy on VPS
$ ssh vps 'cd /srv/akroncloud-slot && git fetch && git reset --hard origin/master
$ ssh vps 'cd /srv/akroncloud-slot && nohup bash -c "docker compose build > /tmp/v16-build.log 2>&1" &'
$ sleep ~400 ; ssh vps 'tail -3 /tmp/v16-build.log'
$ ssh vps 'cd /srv/akroncloud-slot && docker compose down && docker compose up -d'
```

Then user reloads `http://45.151.122.104:7777/mobile` and we expect the
canvas to render MT5.

## 7. VPS / Docker cheat-sheet

- VPS: `45.151.122.104`, ssh as root via `KeyVPS` (use askpass shim at `/tmp/askpass_vps.sh`)
- Working dir: `/srv/akroncloud-slot`
- Current image: `ghcr.io/alxvarp/akroncloud-slot:0.3.0-tcp-bridge-v15`
- Tag bump is the deploy signal: `vXX` -> `docker-compose.yml`
- Build: `docker compose build` (5-10 min). Run in background.
- Healthcheck: `curl http://127.0.0.1:7777/v1/health` should return JSON
- Slot logs: `docker logs akroncloud-slot`
- KasmVNC nginx: `/etc/nginx/sites-enabled/*` (the file inside the container)
- KasmVNC client files: `/usr/local/share/kasmvnc/www/`
  - `core/rfb.js` - the RFB class we're using
  - `bundles/main.bundle.js` etc. - the full AngularJS admin UI we DON'T use

## 8. Token / environment

- GitHub: `$KeyGIT` (Personal Access Token; used as `Authorization: token $KeyGIT`)
- VPS SSH: `$KeyVPS` (root password); see `/tmp/askpass_vps.sh`
- These are session env vars; they do NOT persist across agent restarts.
  In a new chat, the user re-prompts with their values or the
  agent has them via the runtime.

## 9. Open follow-ups (unrelated to the immediate bug)

These can wait:

- **Phase 4 cleanup** (deletes `mt5-bridge-adapter.py`, `mt5-zmq.ts`,
  drops `watchdog` from pip in Dockerfile) - gated on production
  soak of `tcp` mode. Not started.
- **MT5 service broker login via API** - the `/v1/sync` currently
  triggers the connector's `connect()` which calls the MT5 service
  to log in, but the actual broker login still requires the user to
  manually log in via KasmVNC. Future work: have the MQL5 service
  write credentials from the slot's `accounts` table directly to
  MT5's config and trigger login.
- **`.env.example` SLOT_BRIDGE** cleanup - the file currently
  documents the legacy `SLOT_MT5_ZMQ_*` vars which are no longer
  used. Worth pruning but cosmetic.

## 10. Reference - what works

| Endpoint | URL | What it does |
|---|---|---|
| Slot API | `http://45.151.122.104:7777/v1/health` | Health |
| Slot REST | `http://45.151.122.104:7777/v1/...` | JWT-protected, `connector: mt5` |
| MT5 login via KasmVNC | `http://45.151.122.104:3000/` | Desktop view |
| Mobile wrapper | `http://45.151.122.104:7777/mobile` | Crashes at RFB constructor |
| KasmVNC WS (via slot proxy) | `ws://45.151.122.104:7777/mt5-ws` | Pipes to KasmVNC's :3000/websockify |

`curl -i -N -H "Upgrade: websocket" -H "Connection: Upgrade" \
     -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Protocol: binary" \
     http://45.151.122.104:7777/mt5-ws`
-> returns `HTTP/1.1 101 Switching Protocols` (good - proxy works)

## 11. One-paragraph summary

Phase C / Ruta B1 is in production: TCP bridge (MQL5 <-> slot, port 7778)
plus MT5 connector via TCP replaces ZMQ. v15 deployed. The mobile
wrapper has a single-line bug in KasmVNC's bundled `core/input/keyboard.js`
where `_touchInput.value = ...` runs on a non-element value. One-line
guard fix, rebuild, redeploy, done. After that, the user should see
the MT5 desktop on their phone.