# Phase C — Ruta B1: TCP socket MQL5 ↔ slot (reemplazo del bridge)

> **Status:** plan only. No code committed yet.
> **Target latency:** 5–15 ms end-to-end (command and event).
> **Replaces:** `src/services/mt5-bridge-adapter.py` + `src/services/mt5-zmq.ts` +
> file-watcher pattern. Keeps `src/services/mt5-bridge-adapter.py` as a
> fallback during transition.

---

## 1. Context (where we are now)

After PR #1 (merged to `master` as `36ee86d`):

- Slot runs `ghcr.io/alxvarp/akroncloud-slot:0.2.0-mt5-bridge-v8` in
  service-mode (SlotService.mq5 is `#property service`, no chart
  dependency, MT5 launches it via `services.ini`).
- Bridge architecture: `MQL5 → MQL5/Files/*.json → Python watchdog
  bridge-adapter → ZMQ :5557 → Node slot`.
- Three runtimes alive (MQL5/wine, Python, Node), 440 LOC of glue in
  `src/services/mt5-bridge-adapter.py`, ~50–100 ms command latency,
  poll-based event latency (1 s default).

**Problem to solve:** the bridge poll is the bottleneck. We want
sub-20 ms command and event latency so the slot feels like a real-time
control plane for MT5.

**Ruta B1** (chosen 2026-07-19 over poll-50ms Ruta A, paid-ZMQ Ruta B2,
HTTP-long-poll Ruta B3): direct TCP socket from MQL5 to slot via
`ws2_32.dll` (Windows Sockets, already available inside Wine).

---

## 2. Architecture (target)

```
┌──────────────────────┐                  ┌────────────────────┐
│  SlotService.mq5     │   TCP (newline-  │  slot (Node.js)    │
│  (MQL5, in wine)     │ ──delimited ───► │  net.createServer  │
│                      │   JSON, :7778    │  on 127.0.0.1:7778 │
│  ws2_32.dll via      │                  │                    │
│  #import             │ ◄────────────────│  integrates with   │
│                      │                  │  ledger / risk /   │
│  OnTimer @ 5–10 ms   │                  │  connector         │
│  non-blocking recv   │                  │                    │
└──────────────────────┘                  └────────────────────┘
         │                                          │
         │  API C++ MT5                            │  REST :7777
         ▼                                          ▼
   MetaTrader 5                                 client (panel,
   (wine)                                       AkronCloud, curl)
```

**Wire protocol:** newline-delimited JSON over plain TCP. Both
directions. Each frame is a single JSON object terminated by `\n`.
Length-bounded (max 64 KB per frame — fits easily in MT5's
`DatabaseOpen`/`FileWriteString` style buffer constraints).

**Frame types (slot → MQL5, "commands"):**

```json
{ "id": "uuid", "type": "command",
  "action": "open"|"close"|"cancel"|"sltp",
  "payload": { ... } }
```

**Frame types (MQL5 → slot, "events" and "responses"):**

```json
{ "id": "uuid", "type": "response",
  "ok": true|false, "result": {...} | "error": "..." }

{ "type": "event",
  "kind": "fill"|"order_state"|"position"|"account",
  "data": {...}, "ts": 1784494201536 }
```

The `id` in commands ties to `id` in responses (request/response
correlation). Events have no `id` (one-way push).

---

## 3. Phases and tasks

### Phase 0 — Pre-flight checks (no code changes)

**Goal:** confirm the dependency chain works before writing any code.

| Task | Description | Acceptance |
|---|---|---|
| 0.1 | Verify `ws2_32.dll` is reachable from MQL5 inside the `akron-mt5-base:mt5-preinstalled` image. `docker run` it and run `metaeditor64 /compile:test.mq5` with a `#import "ws2_32.dll"` stub. | Compiles without "DLL not found". |
| 0.2 | Verify MT5 in that image can load `ws2_32.dll` at runtime. Write a minimal `WsTest.mq5` that does `socket()` + `closesocket()` in `OnInit()`. Run it inside a slot container, check `metaeditor.log` and MT5 journal for "DLL allowed" / "DLL Import" lines. | No "DLL not allowed" error. |
| 0.3 | Confirm `DLLImport` can be enabled programmatically via the `terminals/*/origin.txt` config OR requires manual Tools > Options toggle. If manual, document the path to write the flag. | Have a deterministic way to enable DLL imports in the image. |

**Verification commands:**

```sh
# In an agent shell (already have docker access):
sudo docker run --rm ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled \
  bash -c 'ls /config/.wine/drive_c/windows/syswow64/ws2_32.dll /opt/wine-stable/lib/wine/ws2_32.dll.so 2>&1 | head -5'
```

**Known unknowns to surface in PR description if found:**

- Whether Wine's `ws2_32` works for non-blocking `ioctlsocket(FIONBIO)` calls.
- Whether MQL5's `#import` macro resolves `ws2_32.dll` correctly without specifying the full path (it should — Windows Sockets is a standard system DLL).
- Whether `OnTimer` at 5–10 ms interferes with MT5's UI repaints.

### Phase 1 — MQL5 TCP client (SlotService.mq5)

**Goal:** SlotService connects to slot, sends events and command
responses, receives commands.

| Task | File | Description |
|---|---|---|
| 1.1 | `mql5/SlotService.mq5` | Add `#import "ws2_32.dll"` block: `WSAStartup`, `socket`, `connect`, `send`, `recv`, `closesocket`, `ioctlsocket`, `select`. |
| 1.2 | same | Add globals: `int g_cmdSock = INVALID_SOCKET; int g_lastSocketError = 0;`. |
| 1.3 | same | In `OnStart()`: `WSAStartup(0x0202, wsadata)`, `socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)`, `connect` to `127.0.0.1:7778`, `ioctlsocket(...FIONBIO, 1)` to make non-blocking. Add retry loop with backoff (initial 500 ms, exponential to 30 s) if `connect` returns SOCKET_ERROR. |
| 1.4 | same | In `OnTimer()`: drain `recv()` (non-blocking, MSG_DONTWAIT), buffer frames by `\n`, parse each as JSON, dispatch to `ProcessCommand()` (extracted from current `TryProcessCommand` — remove the file-based part). |
| 1.5 | same | Add `SendFrame(string json)`: serialize + append `\n` + retry-on-EAGAIN loop + drop frame if socket disconnected (log + reconnect trigger). |
| 1.6 | same | Replace `WriteStartupMarker()` with `SendFrame({type:"event", kind:"startup", ts:...})`. |
| 1.7 | same | Replace `WriteStateFile()` and `AppendLine(slot-events.jsonl, ...)` calls with `SendFrame(...)` of the appropriate event. |
| 1.8 | same | Extract command handling from `TryProcessCommand` (currently reads `slot-cmd.json`) into a pure function `ProcessCommand(string body, string id)` that does `OrderSend` / `PositionClose` / `OrderDelete` / `OrderModify` and returns a JSON result. Send the result back via `SendFrame({id, type:"response", ok, result})`. |
| 1.9 | same | Drop the `MQL5FilesPath()`, `FileIsExist`, `FileOpen` calls. The `slot-state.json`, `slot-events.jsonl`, `slot-cmd.json`, `slot-resp.jsonl`, `slot-autostart.done` files all go away. |
| 1.10 | new `mql5/SocketUtil.mqh` | Helper functions: `int ConnectWithRetry(string host, int port, int maxAttempts)`, `string DrainFrames(int sock, string &buffer)`, `bool SendLine(int sock, string line)`. |
| 1.11 | `Dockerfile` | Update the comment block that says "Communicates with the slot's bridge-adapter purely via files in MQL5/Files/" — change to "Communicates with the slot over a TCP socket on 127.0.0.1:7778 (newline-delimited JSON)". |

**Verification:**

```sh
# 1. compile inside the base image
sudo docker run -d --name mt5-b1-test -e DISPLAY=:0 \
  ghcr.io/alxvarp/akron-mt5-base:mt5-preinstalled
sleep 25
sudo docker cp mql5/SlotService.mq5 mt5-b1-test:/config/.wine/drive_c/users/abc/MetaTrader\ 5/MQL5/Services/SlotService.mq5
sudo docker exec -u root mt5-b1-test bash -c \
  'chown abc:abc "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.mq5"'
sudo docker exec -u abc -e DISPLAY=:0 mt5-b1-test bash -c \
  'cd "/config/.wine/drive_c/users/abc/MetaTrader 5" && /usr/bin/wine "MetaEditor64.exe" /compile:MQL5/Services/SlotService.mq5'
sudo docker exec mt5-b1-test bash -c \
  'cat "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Services/SlotService.log" | tail -5'
# expected: "0 errors, N warnings" where N ≤ 4 (existing ulong→uint plus 1-2 new for DLL imports)

# 2. enable DLL imports in the runtime image
# (one-time, persisted in the image layer)
sudo docker exec -u root mt5-b1-test bash -c \
  'mkdir -p "/config/.wine/drive_c/users/abc/AppData/Roaming/MetaQuotes/Terminal/Common/Files"'
# MT5 writes "AllowDllImport" flag to a config file when user toggles it.
# Programmatic approach: create a pre-configured user profile directory
# with the right settings file. Details TBD in task 0.3.
```

### Phase 2 — Node TCP server (slot side)

**Goal:** slot listens on `127.0.0.1:7778`, accepts the MQL5
connection, demultiplexes frames to the right handler.

| Task | File | Description |
|---|---|---|
| 2.1 | new `src/services/mt5-tcp-server.ts` | `net.createServer({ allowHalfOpen: false })` bound to `127.0.0.1:7778`. Single connection enforced (kick prior on new). |
| 2.2 | same | Frame parser: TCP `data` events are byte streams; accumulate in a per-connection buffer, split on `\n`, JSON.parse each complete frame. Incomplete trailing bytes stay buffered. |
| 2.3 | same | Frame dispatcher: `type === "event"` → `ledger.insertEvent(...)` + WS broadcast. `type === "response"` → resolve the matching pending command Promise (see 2.4). |
| 2.4 | new `src/services/command-router.ts` | `Promise<CommandResult> dispatchCommand(cmd): Promise` — generates UUID, registers the pending Promise in a Map, writes frame to MQL5 socket, returns the Promise. Timeout 5 s → resolve with `{ok:false, error:"timeout"}`. |
| 2.5 | `src/api/rest.ts` | In `POST /v1/orders`, replace the current `validateAccount + openTrade` path with: `validateAccount → dispatchCommand → reply with the result`. Backpressure: if MT5 socket is down, return 503 with `Retry-After`. |
| 2.6 | `src/services/mt5-bridge-adapter.py` | **Keep as fallback** but feature-flag it: `SLOT_BRIDGE=file` (default, current behavior) or `SLOT_BRIDGE=tcp` (new behavior). Document the flag in `.env.example`. |
| 2.7 | `src/services/mt5-zmq.ts` | **Delete or feature-flag** similarly. When `SLOT_BRIDGE=tcp`, do not start the ZMQ subscriber. |
| 2.8 | `src/app.ts` | Conditionally start `mt5-tcp-server.ts` only when `SLOT_BRIDGE=tcp`. |
| 2.9 | `src/services/index.ts` | Export `mt5-tcp-server.ts`. |

**Verification:**

```sh
# Manual smoke test
SLOT_BRIDGE=tcp npm run dev &
sleep 3
# Use a stub TCP client to simulate MQL5:
node -e "
const net = require('net');
const s = net.connect(7778, '127.0.0.1');
s.write(JSON.stringify({type:'event', kind:'test', ts:Date.now()})+'\n');
s.end();
"
sleep 1
# Expected: no errors in slot logs, event was processed by the ledger

# Then real test: send a command frame and expect a response
node -e "
const net = require('net');
const s = net.connect(7778, '127.0.0.1');
s.on('data', d => { console.log('got:', d.toString()); s.end(); });
s.write(JSON.stringify({id:'test-1', type:'command', action:'noop'})+'\n');
"
```

### Phase 3 — Dual-stack transition

**Goal:** ship `tcp` and `file` paths side-by-side, switch via
`SLOT_BRIDGE` env var, default to `tcp` only after VPS smoke test.

| Task | Description |
|---|---|
| 3.1 | Land Phase 1 + 2 behind `SLOT_BRIDGE=tcp`. Default remains `file` for one release. |
| 3.2 | Update `docker-compose.yml` on VPS: add `SLOT_BRIDGE=tcp` env var, build new image with tag `0.3.0-b1-tcp`. |
| 3.3 | Manual latency benchmark on VPS: `time curl -X POST /v1/orders` with `SLOT_BRIDGE=file` vs `SLOT_BRIDGE=tcp`. Expected delta: ≥10× faster on `tcp`. |
| 3.4 | Once benchmark passes: flip default to `tcp` in a follow-up commit. |
| 3.5 | Document the rollout in `docs/handbook/KNOWLEDGE.md` (anti-pattern: never enable DLLImport without a layer audit; risk: ws2_32 in MT5 is unaudited). |

### Phase 4 — Cleanup (after 1 week of `tcp` in production)

**Goal:** delete the Python bridge-adapter, ZMQ subscriber, file
protocol references.

| Task | File | Action |
|---|---|---|
| 4.1 | `src/services/mt5-bridge-adapter.py` | Delete. |
| 4.2 | `src/services/mt5-zmq.ts` | Delete. |
| 4.3 | `Dockerfile` | Drop the `RUN pip3 install watchdog` line. |
| 4.4 | `Dockerfile` | Drop the `RUN mkdir ... MQL5/Files/` line (no more file I/O). |
| 4.5 | `src/services/login-detector.ts` | If any code references file-based MT5 state, update. (Currently does, indirectly.) |
| 4.6 | `docs/CONNECTORS.md` | Update any reference to file-based event protocol. |
| 4.7 | `SPEC.md` | Update §4 (broker connector) and §5 (data model) to reflect TCP transport. |
| 4.8 | `.env.example` | Remove `SLOT_MT5_ZMQ_*` vars, add `SLOT_BRIDGE=tcp` (default), `SLOT_MT5_TCP_PORT=7778`. |

---

## 4. Key code sketches

### 4.1 — MQL5 side (`SlotService.mq5`)

```cpp
//+------------------------------------------------------------------+
//| Socket imports                                                     |
//+------------------------------------------------------------------+
#import "ws2_32.dll"
   int WSAStartup(short wVersionRequired, uchar &lpWSAData[]);
   int WSACleanup();
   int socket(int af, int type, int protocol);
   int connect(int s, uchar &name[], int namelen);
   int send(int s, const uchar &buf[], int len, int flags);
   int recv(int s, uchar &buf[], int len, int flags);
   int closesocket(int s);
   int ioctlsocket(int s, long cmd, uchar &argp[]);
   int select(int nfds, uchar &readfds[], uchar &writefds[],
              uchar &exceptfds[], const int &timeout);
#import

//+------------------------------------------------------------------+
//| Globals                                                            |
//+------------------------------------------------------------------+
#define INVALID_SOCKET (-1)
#define SOCKET_ERROR   (-1)
#define AF_INET        2
#define SOCK_STREAM     1
#define IPPROTO_TCP     6
#define MSG_DONTWAIT   0x40

input int  CmdSocketPort = 7778;     // 127.0.0.1:7778
input string CmdSocketHost = "127.0.0.1";
input int  ReconnectBackoffMs = 500;
input int  MaxBackoffMs      = 30000;

int   g_cmdSock = INVALID_SOCKET;
int   g_recvBufMax = 65536;
string g_recvBuf = "";  // newline-delimited JSON accumulator

//+------------------------------------------------------------------+
//| OnStart — connect to slot                                           |
//+------------------------------------------------------------------+
int OnStart()
{
   PrintFormat("SlotService: start (service mode, TCP)");
   uchar wsadata[408];
   if(WSAStartup(0x0202, wsadata) != 0) {
      Print("SlotService: WSAStartup failed");
      return INIT_FAILED;
   }
   ConnectToSlot();
   EventSetMillisecondTimer(MathMax(10, PollSeconds * 1000));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| ConnectWithRetry                                                   |
//+------------------------------------------------------------------+
void ConnectToSlot()
{
   if(g_cmdSock != INVALID_SOCKET) {
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
   }
   int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
   if(sock == INVALID_SOCKET) {
      PrintFormat("SlotService: socket() failed, errno=%d", GetLastError());
      return;
   }
   // sockaddr_in: family=AF_INET, port=htons(port), addr=inet_addr(host)
   uchar addr[16];
   ArrayInitialize(addr, 0);
   addr[0] = (uchar)(AF_INET & 0xFF);
   addr[1] = (uchar)((AF_INET >> 8) & 0xFF);
   ushort port_be = (ushort)((CmdSocketPort >> 8) | (CmdSocketPort << 8));
   addr[2] = (uchar)(port_be & 0xFF);
   addr[3] = (uchar)((port_be >> 8) & 0xFF);
   addr[4] = 127; addr[5] = 0; addr[6] = 0; addr[7] = 1;
   int rc = connect(sock, addr, 16);
   if(rc == SOCKET_ERROR) {
      PrintFormat("SlotService: connect() failed, errno=%d", GetLastError());
      closesocket(sock);
      return;
   }
   g_cmdSock = sock;
   PrintFormat("SlotService: connected to slot at %s:%d",
               CmdSocketHost, CmdSocketPort);
   SendStartupEvent();
}

//+------------------------------------------------------------------+
//| SendFrame — non-blocking send with retry                            |
//+------------------------------------------------------------------+
bool SendFrame(string json)
{
   if(g_cmdSock == INVALID_SOCKET) return false;
   string line = json + "\n";
   uchar buf[];
   StringToCharArray(line, buf, 0, StringLen(line), CP_UTF8);
   int sent = 0;
   while(sent < ArraySize(buf)) {
      int n = send(g_cmdSock, buf, ArraySize(buf) - sent, MSG_DONTWAIT);
      if(n == SOCKET_ERROR) {
         PrintFormat("SlotService: send failed, errno=%d", GetLastError());
         closesocket(g_cmdSock);
         g_cmdSock = INVALID_SOCKET;
         return false;
      }
      sent += n;
   }
   return true;
}

//+------------------------------------------------------------------+
//| OnTimer — recv commands + reconnect watchdog                        |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(g_cmdSock == INVALID_SOCKET) {
      ConnectToSlot();  // try again; OnTimer cadence acts as backoff
      return;
   }
   // Drain recv
   uchar buf[4096];
   int n = recv(g_cmdSock, buf, 4096, MSG_DONTWAIT);
   if(n == SOCKET_ERROR) {
      PrintFormat("SlotService: recv error %d, reconnecting", GetLastError());
      closesocket(g_cmdSock);
      g_cmdSock = INVALID_SOCKET;
      return;
   }
   if(n > 0) {
      g_recvBuf += CharArrayToString(buf, 0, n, CP_UTF8);
      // Process complete frames (newline-delimited)
      int idx;
      while((idx = StringFind(g_recvBuf, "\n")) >= 0) {
         string frame = StringSubstr(g_recvBuf, 0, idx);
         g_recvBuf = StringSubstr(g_recvBuf, idx + 1);
         ProcessCommandFrame(frame);
      }
      if(StringLen(g_recvBuf) > g_recvBufMax) {
         Print("SlotService: recv buffer overflow, dropping");
         g_recvBuf = "";
      }
   }
   // Periodically push state snapshot (legacy poll duty — every ~1 s)
   if(TimeCurrent() - g_lastStatePush >= PollSeconds) {
      g_lastStatePush = TimeCurrent();
      SendFrame("{\"type\":\"event\",\"kind\":\"state\",\"ts\":"
                + TimeToMs(TimeCurrent()) + ",\"data\":"
                + BuildStateJson() + "}");
   }
}

//+------------------------------------------------------------------+
//| ProcessCommandFrame — parse + execute                               |
//+------------------------------------------------------------------+
void ProcessCommandFrame(string frame)
{
   string id      = JsonField(frame, "id");
   string action = JsonField(frame, "action");
   bool ok = false;
   string result = "{\"error\":\"unknown_action\"}";
   if(action == "open")   { ok = true; result = HandleOpen(frame); }
   else if(action == "close")  { ok = true; result = HandleClose(frame); }
   else if(action == "cancel") { ok = true; result = HandleCancel(frame); }
   else if(action == "sltp")   { ok = true; result = HandleSltp(frame); }
   SendFrame("{\"id\":\"" + id + "\",\"type\":\"response\",\"ok\":"
             + (ok ? "true" : "false") + ",\"result\":" + result + "}");
}
```

### 4.2 — Node side (`src/services/mt5-tcp-server.ts`)

```typescript
import net from 'node:net';
import { log } from '../log.js';

type Frame =
  | { type: 'event'; kind: string; data: unknown; ts: number }
  | { type: 'response'; id: string; ok: boolean; result?: unknown; error?: string };

type PendingCommand = {
  resolve: (r: { ok: boolean; result?: unknown; error?: string }) => void;
  timer: NodeJS.Timeout;
};

const CMD_TIMEOUT_MS = 5_000;
const BIND_PORT = Number(process.env.SLOT_MT5_TCP_PORT ?? 7778);

export class Mt5TcpServer {
  private server?: net.Server;
  private sock?: net.Socket;
  private recvBuf = '';
  private pending = new Map<string, PendingCommand>();

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer({ allowHalfOpen: false }, (sock) => {
        this.handleConnection(sock);
      });
      this.server.on('error', reject);
      this.server.listen(BIND_PORT, '127.0.0.1', () => {
        log.info({ port: BIND_PORT }, 'MT5 TCP server listening');
        resolve();
      });
    });
  }

  private handleConnection(sock: net.Socket): void {
    if (this.sock) {
      log.warn('MT5 TCP: replacing existing connection');
      this.sock.destroy();
    }
    this.sock = sock;
    this.recvBuf = '';
    log.info({ remote: sock.remoteAddress }, 'MT5 TCP: connected');

    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('close', () => this.onClose());
    sock.on('error', (err) => log.warn({ err }, 'MT5 TCP: socket error'));
  }

  private onData(chunk: Buffer): void {
    this.recvBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.recvBuf.indexOf('\n')) >= 0) {
      const frame = this.recvBuf.slice(0, idx);
      this.recvBuf = this.recvBuf.slice(idx + 1);
      try {
        this.dispatch(JSON.parse(frame));
      } catch (err) {
        log.warn({ err, frame }, 'MT5 TCP: bad frame');
      }
    }
    if (this.recvBuf.length > 65_536) {
      log.warn('MT5 TCP: recv buffer overflow, dropping');
      this.recvBuf = '';
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.type === 'response') {
      const p = this.pending.get(frame.id);
      if (!p) {
        log.warn({ id: frame.id }, 'MT5 TCP: response for unknown id');
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      p.resolve({
        ok: frame.ok,
        ...(frame.result !== undefined ? { result: frame.result } : {}),
        ...(frame.error !== undefined ? { error: frame.error } : {}),
      });
    } else if (frame.type === 'event') {
      // Hand off to ledger/WS broadcast
      this.onEvent?.(frame);
    }
  }

  /** Caller (REST handler) uses this to send a command and await the response. */
  dispatchCommand(cmd: object, id: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.sock) return Promise.reject(new Error('MT5 socket not connected'));
    const line = JSON.stringify(cmd) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.sock!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onClose(): void {
    log.warn('MT5 TCP: disconnected');
    this.sock = undefined;
    // Reject all pending commands
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'mt5_disconnected' });
      this.pending.delete(id);
    }
  }

  /** Set by app.ts to forward events to ledger/WS. */
  onEvent?: (frame: Extract<Frame, { type: 'event' }>) => void;
}
```

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wine's `ws2_32` doesn't implement `ioctlsocket(FIONBIO)` | low | service won't connect | use blocking sockets with `select()` timeout instead (always-available alternative). |
| MT5 `OnTimer` at 10 ms blocks chart UI repaints | medium | UX degraded during MT5 desktop use | bump OnTimer to 50 ms while still keeping <100 ms end-to-end latency (still 10× better than current). |
| DLL import blocked at MT5 runtime by missing config | medium | feature doesn't ship | Phase 0.3 explicitly validates this before code lands. |
| MQL5 `recv()` partial reads drop bytes | low | dropped commands | accumulator + newline framing; explicitly tested in Phase 2.2. |
| Slot restart while MQL5 connected → MQL5 keeps stale socket | high (eventual) | commands silently fail | MQL5 must detect `recv() == 0` (graceful close) and reconnect on next `OnTimer`. |
| MQL5 thread-safety in socket writes from `OnTradeTransaction` | low | races with `OnTimer` send | keep `OnTradeTransaction` handler short — push the frame to a queue, drain from `OnTimer`. |
| `slot-state.json` consumers (e.g. login-detector) break | medium | login-detector fails | audit `src/services/login-detector.ts` in Phase 4.5. |

---

## 6. Acceptance criteria for the whole phase

1. End-to-end order placement latency (slot API → MT5 OrderSend →
   response back to slot API) is **<100 ms p50, <200 ms p95** when
   measured from VPS via `time curl -X POST /v1/orders`.
2. Event latency (MT5 `OnTradeTransaction` → WS broadcast) is
   **<50 ms p50, <100 ms p95**.
3. Slot restart does not require MT5 restart — MQL5 reconnects
   automatically within one OnTimer cycle.
4. With the `SLOT_BRIDGE=file` fallback, the existing v8 behavior
   works unchanged (regression-safe).
4. Dockerfile no longer installs `watchdog` Python package.
5. No new top-level deps in `package.json` (use built-in `net`).

---

## 7. Rollback plan

- Phase 3 ships with `SLOT_BRIDGE=tcp` opt-in. Setting
  `SLOT_BRIDGE=file` (the default) keeps v8 behavior.
- If latency regression or instability is observed in production,
  revert via env var (no redeploy).
- If DLL imports fail at runtime in some MT5 build, fall back to
  the file path and reassess.

---

## 8. References

- MQL5 winsock reference: `https://www.mql5.com/en/docs/standardlibrary`
  (search for `WSASocket`, `WSAStartup`; `#import` examples).
- MQL5 `#import` directive: `https://www.mql5.com/en/docs/basis/operators/import`
- Node `net` module: `https://nodejs.org/api/net.html`
- Akron legacy sunset context: `SUNSET.md` in `AlxVarp/Akron`.
- Phase B TODO (file/ZMQ path being replaced): `src/PHASE_B_TODO.ts`.
- Existing service-mode revert (commit chain ending in `1e09523`):
  branch `feature/phase-a-mt5-slot`, PR #1, merged to `master@36ee86d`.

---

## 9. Open questions for the next session

1. Should the `SLOT_BRIDGE=tcp` opt-in ship in v8 (current
   behavior stays default) or wait for v9?
2. Do we want a `SLOT_MT5_TCP_AUTH_TOKEN` header on the socket
   (loopback-only is fine without, but defense-in-depth)?
3. Should we expose `mt5-tcp-server.ts` over Unix socket (faster,
   no port collision) instead of TCP? Pros/cons?
4. Worth a Phase D plan to also push events over the same socket
   from MQL5's `OnTradeTransaction` directly (skipping the OnTimer
   state-poll loop entirely)?

---

_Last updated: 2026-07-19. Author: openhands. Status: pre-implementation._