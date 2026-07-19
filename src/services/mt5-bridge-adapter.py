#!/usr/bin/env python3
"""
mt5-bridge-adapter — file_bridge between the MQL5 chart-indicator
(SlotService.mq5, compiled to MQL5/Indicators/SlotService.ex5) and
the slot's Mt5Connector (Node.js, in src/connectors/mt5.ts).

Replaces the previous bridge HTTP proxy (mt5copy_bridge). The MQL5
indicator writes everything to MQL5/Files/ (events, state, startup
marker, commands read). The adapter:

  - watches MQL5/Files/slot-events.jsonl for new lines (one JSON per
    line) and publishes each to ZMQ :5557 (events stream)
  - watches MQL5/Files/slot-state.json for snapshots and re-publishes
    the latest on changes (so /v1/state works even before the first
    tick of the chart)
  - subscribes ZMQ :5556 (commands from the slot's Mt5Connector) and
    writes them to MQL5/Files/slot-cmd.json (atomic write via .tmp +
    rename so the indicator sees a complete file)
  - watches MQL5/Files/slot-resp.jsonl for command responses (kept
    for debugging, the slot doesn't currently consume these)

No HTTP bridge, no mt5linux_server, no rpyc. Just file I/O + ZMQ.

Run via s6 as `svc-mt5-bridge-adapter` (the Dockerfile sets this up).
"""
import json
import os
import time
from threading import Thread

import zmq
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

MT5_FILES         = "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Files"
EVENTS_FILE       = f"{MT5_FILES}/slot-events.jsonl"
STATE_FILE        = f"{MT5_FILES}/slot-state.json"
CMD_FILE          = f"{MT5_FILES}/slot-cmd.json"
RESP_FILE         = f"{MT5_FILES}/slot-resp.jsonl"

ZMQ_CMD_ENDPOINT  = os.environ.get("ZMQ_CMD_ENDPOINT", "tcp://127.0.0.1:5556")
ZMQ_EVT_ENDPOINT  = os.environ.get("ZMQ_EVT_ENDPOINT", "tcp://*:5557")
LOG_LEVEL         = os.environ.get("LOG_LEVEL", "info").upper()
BOOT_WAIT_SECONDS = int(os.environ.get("BOOT_WAIT_SECONDS", "180"))

import logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s bridge-adapter %(message)s",
)
log = logging.getLogger("bridge-adapter")


_last_state_json = None
_events_offset   = 0
_resp_offset     = 0


def _read_new_lines(path, start_offset):
    out = []
    try:
        with open(path, "rb") as f:
            f.seek(start_offset)
            data = f.read()
    except FileNotFoundError:
        return out, start_offset
    except Exception as exc:
        log.warning("read %s failed: %s", path, exc)
        return out, start_offset
    if not data:
        return out, start_offset
    out = data.decode("utf-8", errors="replace").splitlines()
    return out, start_offset + len(data)


def _publish_state_once(pub, initial=False):
    global _last_state_json
    try:
        with open(STATE_FILE, "r") as f:
            data = f.read().strip()
    except FileNotFoundError:
        return
    except Exception as exc:
        log.warning("read %s failed: %s", STATE_FILE, exc)
        return
    if not data:
        return
    if data == _last_state_json and not initial:
        return
    _last_state_json = data
    try:
        json.loads(data)
    except json.JSONDecodeError:
        return
    log.debug("publish state snapshot")
    pub.send_string(json.dumps({"kind": "state", "data": json.loads(data)}))


class _FileHandler(FileSystemEventHandler):
    def __init__(self, pub):
        super().__init__()
        self.pub = pub

    def _drain_events(self):
        global _events_offset
        lines, _events_offset = _read_new_lines(EVENTS_FILE, _events_offset)
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                log.debug("skip malformed event: %r", line[:120])
                continue
            log.debug("emit event %s", obj.get("kind"))
            self.pub.send_string(line)

    def _drain_state(self):
        _publish_state_once(self.pub)

    def _drain_resp(self):
        global _resp_offset
        lines, _resp_offset = _read_new_lines(RESP_FILE, _resp_offset)
        for line in lines:
            log.info("resp from MT5: %s", line.strip()[:200])

    def on_modified(self, event):
        p = event.src_path
        if p == EVENTS_FILE:
            self._drain_events()
        elif p == STATE_FILE:
            self._drain_state()
        elif p == RESP_FILE:
            self._drain_resp()

    def on_created(self, event):
        self.on_modified(event)


def _write_atomic(path, body):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.replace(tmp, path)


def command_loop(cmd_sock, pub):
    log.info("SUB commands on %s", ZMQ_CMD_ENDPOINT)
    while True:
        try:
            raw = cmd_sock.recv()
        except Exception as exc:
            log.warning("cmd recv: %s; reconnecting", exc)
            time.sleep(1.0)
            continue
        try:
            cmd = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            log.warning("bad json on cmd: %s", exc)
            continue
        try:
            slim = {
                "id": cmd.get("id", ""),
                "action": cmd.get("action"),
                "payload": cmd.get("payload", {}),
            }
            _write_atomic(CMD_FILE, json.dumps(slim))
            log.info("cmd %s id=%s", cmd.get("action"), slim["id"])
        except Exception as exc:
            log.warning("write cmd failed: %s", exc)


def main():
    log.info("starting bridge-adapter: events=%s state=%s cmd=%s zmq_cmd=%s zmq_evt=%s",
             EVENTS_FILE, STATE_FILE, CMD_FILE, ZMQ_CMD_ENDPOINT, ZMQ_EVT_ENDPOINT)

    deadline = time.time() + BOOT_WAIT_SECONDS
    while time.time() < deadline:
        if os.path.isdir(MT5_FILES):
            break
        log.info("waiting for %s to exist (chart-indicator not attached yet?)", MT5_FILES)
        time.sleep(5.0)

    ctx = zmq.Context.instance()
    cmd_sock = ctx.socket(zmq.SUB)
    cmd_sock.connect(ZMQ_CMD_ENDPOINT)
    cmd_sock.setsockopt_string(zmq.SUBSCRIBE, "")

    pub = ctx.socket(zmq.PUB)
    pub.bind(ZMQ_EVT_ENDPOINT)
    log.info("PUB events bound on %s", ZMQ_EVT_ENDPOINT)

    _publish_state_once(pub, initial=True)

    handler = _FileHandler(pub)
    obs = Observer()
    obs.schedule(handler, path=MT5_FILES, recursive=False)
    obs.start()
    log.info("watching %s", MT5_FILES)

    try:
        handler._drain_events()
        handler._drain_state()
    except Exception as exc:
        log.warning("initial drain: %s", exc)

    command_loop(cmd_sock, pub)


if __name__ == "__main__":
    main()
