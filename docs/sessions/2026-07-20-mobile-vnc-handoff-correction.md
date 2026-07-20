# Mobile VNC wrapper — correction to today's earlier handoff (2026-07-20 PM)

> **TL;DR:** The earlier handoff
> (`docs/sessions/2026-07-20-mobile-vnc-handoff.md`) misdiagnosed
> the bug. The actual root cause is in **the call site
> `src/web/mobile.html.ts:309`**, not in
> `src/web/vnc-static/core/input/keyboard.js`. The keyboard.js
> patch is also applied as defense-in-depth, but it's secondary.

---

## 1. What the earlier handoff got wrong

It claimed:
> "The RFB constructor expects the second arg to be the keyboard
> input element, but in the bundled fork it's somehow getting the
> URL or undefined."

Actually, the bundled KasmVNC fork's RFB constructor signature
is the opposite of what was assumed:

```js
// src/web/vnc-static/core/rfb.js:75
constructor(target, touchInput, urlOrChannel, options, isPrimaryDisplay)
```

The URL is the **3rd** positional arg, not the 2nd. The earlier
handoff applied the old noVNC 1.x mental model
(`new RFB(target, url, options)`) where touchInput didn't exist
as a separate slot.

## 2. The actual call site

`src/web/mobile.html.ts:309` (before fix):

```js
rfb = new RFB(canvas, wsUrlFallback, { ...options });
```

This maps to:
- `target` = `canvas` (correct)
- `touchInput` = `wsUrlFallback` ← **string**, becomes
  `this._touchInput` in Keyboard
- `urlOrChannel` = `{...options}` (an object, not a string!)
- `options` = `undefined`

Two cascading bugs:

1. **Keyboard crash (the visible TypeError).** `_keyboardInputReset`
   does `this._touchInput.value = ...`. `this._touchInput` is the
   URL string → "Cannot create property 'value' on string
   'ws://45.151.122.104/mt5-ws'".
2. **WebSocket never connects (silent).** Because `urlOrChannel`
   was the options object (not a string), `rfb.js:87-92` does:
   ```js
   if (typeof urlOrChannel === "string") {
       this._url = urlOrChannel;
   } else {
       this._url = null;
       this._rawChannel = urlOrChannel;
   }
   ```
   `_url` ends up `null` and `_rawChannel` becomes the options dict.
   The WS setup never opens.

The earlier handoff's keyboard.js-only patch would have hidden
the visible TypeError but **the WS still would not have connected**.
This is why both fixes are applied.

## 3. Fixes applied

### 3.1 Call site (`src/web/mobile.html.ts:317`)

```js
rfb = new RFB(canvas, null, wsUrlFallback, { ...options });
```

Inserted `null` as the 2nd arg so URL lands in the right slot.
Wrapper has its own creds modal that types via `rfb.sendKey`,
so the IME-on-canvas path (which would need a real touchInput
element) is not used here.

### 3.2 Defense in depth (`src/web/vnc-static/core/input/keyboard.js:267`)

```js
_keyboardInputReset() {
    if (!this._touchInput || typeof this._touchInput !== 'object'
        || !('value' in this._touchInput)) {
        this._lastKeyboardInput = '';
        return;
    }
    this._touchInput.value = new Array(this._defaultKeyboardInputLen).join("_");
    this._lastKeyboardInput = this._touchInput.value;
}
```

Doesn't fix anything on its own in this scenario, but stops
the constructor from crashing if a future caller passes null
again or if the KasmVNC fork's API shifts upstream.

## 4. Build verification

```
$ npm run build
> tsc -p tsconfig.build.json
> rm -rf dist/web/vnc-static && cp -r src/web/vnc-static dist/web/vnc-static
```

Both patches propagated to `dist/`:

- `dist/web/mobile.html.js:316` →
  `rfb = new RFB(canvas, null, wsUrlFallback, {`
- `dist/web/vnc-static/core/input/keyboard.js:268` →
  `// Defense in depth: upstream KasmVNC fork assumes touchInput is a`

## 5. Tag bump + commit

`docker-compose.yml`: `0.3.0-tcp-bridge-v15` → `0.3.0-tcp-bridge-v16`.

Changes are **uncommitted and unpushed** as of writing this note.
Per repo conventions, push/PR needs explicit user confirmation.

## 6. Deploy steps for the next chat (no push yet)

```
$ cd /home/openhands/workspace/project/AkronCloud-Slot
$ git diff --stat                              # sanity-check the diff
$ git add -A
$ git commit -m "fix(web): pass null as RFB touchInput; guard Keyboard"
# STOP HERE - ask user before pushing/building on VPS
```

After push + VPS rebuild:

```
$ ssh vps 'cd /srv/akroncloud-slot && git pull'
$ ssh vps 'cd /srv/akroncloud-slot && docker compose build'   # 5-10 min
$ ssh vps 'cd /srv/akroncloud-slot && docker compose down && docker compose up -d'
```

Then user reloads `http://45.151.122.104:7777/mobile`. Expected:

- No TypeError in console.
- `connect` event fires.
- MT5 desktop renders in the canvas.
- `fillFromCreds()` types broker login into MT5.

## 7. Open follow-ups (unchanged)

Same as earlier handoff §9 — Phase 4 cleanup, MT5 service broker
login via API, `.env.example` SLOT_BRIDGE cleanup.