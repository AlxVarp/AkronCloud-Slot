#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mt5-state-bridge — v55

Forwards MT5 account state from the MQL5 chart indicator
`AccountReporter.ex5` to the slot's Mt5TcpServer over TCP
127.0.0.1:7778.

Wire protocol (same as SlotService.ex5 + mt5-account-publisher.py):
    newline-delimited JSON frames
    {"type":"event","kind":"account","data":{...},"ts":<epoch_ms>}

The indicator writes `MQL5/Files/slot-state.json` (atomically via
.tmp + rename) every PollSeconds (default 5). This script polls the
file every POLL_MS, diffs against the last published payload, and
sends only on change. Auto-reconnects the TCP socket if the slot
restarts.

Pre-conditions (provided by Dockerfile v55):
    - /config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Indicators/
      AccountReporter.ex5 exists (the compiled chart indicator)
    - MT5 terminal64.exe is running (svc-de → openbox autostart)
    - A chart is open in MT5 with AccountReporter attached (one-time
      manual step per fresh WINEPREFIX; see AccountReporter.mq5 header)
    - Slot's Mt5TcpServer is listening on 127.0.0.1:7778 (svc-slot)

Behavior:
    - Polls slot-state.json every POLL_MS
    - Only sends a frame when the JSON content changes (cheap dedupe)
    - Sends a `startup` heartbeat every HEARTBEAT_S so the slot
      knows this bridge is alive even when the user isn't logged in
      and the file hasn't changed
    - Auto-reconnects TCP on send failure
    - Logs to stdout — the s6 service captures it via s6-log
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import sys
import time
from typing import Any, Optional

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("mt5-state-bridge")

# MQL5/Files/ lives inside the wineprefix. Same path the indicator
# writes to and the bridge-adapter.py already reads from.
STATE_FILE = (
    "/config/.wine/drive_c/users/abc/MetaTrader 5/MQL5/Files/slot-state.json"
)

SLOT_HOST = os.environ.get("SLOT_MT5_TCP_HOST", "127.0.0.1")
SLOT_PORT = int(os.environ.get("SLOT_MT5_TCP_PORT", "7778"))
POLL_MS = int(os.environ.get("MT5_STATE_POLL_MS", "1000"))
HEARTBEAT_S = float(os.environ.get("MT5_STATE_HEARTBEAT_S", "30"))

_stop = False


def _on_signal(signum, _frame):
    global _stop
    log.info("signal %d received — shutting down", signum)
    _stop = True


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)


def frame(kind: str, data: dict[str, Any]) -> bytes:
    """Build a newline-delimited JSON frame for the slot's Mt5TcpServer."""
    return (
        json.dumps(
            {"type": "event", "kind": kind, "data": data, "ts": int(time.time() * 1000)},
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


class SlotClient:
    """Auto-reconnecting TCP client for the slot's Mt5TcpServer (7778)."""

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None

    def connect(self) -> bool:
        try:
            s = socket.create_connection((self.host, self.port), timeout=3)
            s.settimeout(None)
            self.sock = s
            log.info("connected to slot at %s:%d", self.host, self.port)
            return True
        except OSError as e:
            log.debug("slot connect failed: %s", e)
            self.sock = None
            return False

    def send(self, payload: bytes) -> bool:
        if self.sock is None and not self.connect():
            return False
        try:
            self.sock.sendall(payload)
            return True
        except OSError as e:
            log.warning("slot send failed: %s — will reconnect", e)
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
            return False

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


def read_state_file() -> Optional[dict[str, Any]]:
    """Read slot-state.json. Returns None if file missing or unreadable.
    Returns the parsed JSON if it parses, else returns the raw string
    wrapped (we still publish so the slot can see 'file changed')."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except FileNotFoundError:
        return None
    except OSError as e:
        log.warning("read %s failed: %s", STATE_FILE, e)
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("bad json in %s: %s", STATE_FILE, e)
        return None


def loop() -> int:
    """Main poll loop. Returns exit code (always 0 — we restart via s6)."""
    log.info(
        "starting (slot=%s:%d, state_file=%s, poll_ms=%d, heartbeat_s=%.0f)",
        SLOT_HOST, SLOT_PORT, STATE_FILE, POLL_MS, HEARTBEAT_S,
    )
    client = SlotClient(SLOT_HOST, SLOT_PORT)
    last_raw: Optional[str] = None
    last_heartbeat = 0.0

    while not _stop:
        now = time.monotonic()
        state = read_state_file()

        if state is not None:
            # Compare against last published JSON to dedupe.
            # We compare raw strings (not parsed objects) so any change —
            # even whitespace — triggers a republish, which is fine for
            # the dedupe purpose (the slot's Mt5Connector does its own
            # dedupe by value).
            raw = json.dumps(state, separators=(",", ":"), sort_keys=True)
            if raw != last_raw:
                # Strip the `ts` field from the indicator's output if
                # present — the slot's AnyEvent schema doesn't require
                # it and we set our own `ts` at the frame level.
                data = {k: v for k, v in state.items() if k != "ts"}
                payload = frame("account", data)
                if client.send(payload):
                    last_raw = raw
                    log.info(
                        "published account: login=%s server=%s balance=%.2f equity=%.2f logged_in=%s",
                        data.get("login"), data.get("server"),
                        data.get("balance", 0.0), data.get("equity", 0.0),
                        data.get("logged_in"),
                    )
                else:
                    # Send failed — don't update last_raw so we retry
                    # next iteration.
                    pass
        else:
            # File missing or unreadable. Don't republish old state.
            last_raw = None

        # Heartbeat every HEARTBEAT_S — keeps the slot aware we're alive
        # and gives it a chance to log a fresh event line for log
        # correlation.
        if now - last_heartbeat >= HEARTBEAT_S:
            if client.send(frame("startup", {})):
                last_heartbeat = now

        # Sleep in small slices so SIGTERM is responsive.
        slept_ms = 0
        while slept_ms < POLL_MS and not _stop:
            time.sleep(min(0.1, (POLL_MS - slept_ms) / 1000.0))
            slept_ms += 100

    client.close()
    log.info("bridge loop exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(loop())