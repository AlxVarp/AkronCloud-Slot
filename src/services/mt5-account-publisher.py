#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mt5-account-publisher — v54

Reads `mt5.account_info()` from the running MetaTrader 5 terminal and
publishes the result to the slot's Mt5TcpServer over TCP 127.0.0.1:7778.

Wire protocol (matches SlotService.ex5):
    newline-delimited JSON frames
    {"type":"event","kind":"account","data":{...},"ts":<epoch_ms>}

The slot's connector (src/connectors/mt5.ts handleEvent) updates
balance/equity/loggedIn per-account from the data fields:
    data.logged_in : bool  (required to flip loggedIn on the connector)
    data.login     : int | str
    data.server    : str
    data.balance   : float
    data.equity    : float
    data.last_error: str   (publishes an 'account:error' bus event)

Run under wine:
    WINEPREFIX=/config/.wine HOME=/config XDG_RUNTIME_DIR=/config/.XDG \
    DISPLAY=:0 PYTHONHASHSEED=0 \
    /opt/wine-stable/bin/wine \
    /config/.wine/drive_c/Python39/python.exe \
    /opt/akron-mt5-account-publisher.py

Pre-conditions (provided by Dockerfile v54):
    - /config/.wine/drive_c/Python39/python.exe exists (64-bit embeddable)
    - MetaTrader5, numpy, numpy.libs/ installed in site-packages
    - msvcp140/vcruntime140/vcruntime140_1/ucrtbase next to python.exe
    - MT5 terminal64.exe is running (svc-de -> openbox autostart)
    - Slot's Mt5TcpServer is listening on 127.0.0.1:7778 (svc-slot)

Behavior:
    - Retries mt5.initialize() forever on IPC failures (named pipe may
      not be ready when the script starts; MT5 takes ~30s to fully boot)
    - Polls account_info() every POLL_SECS
    - Only emits a frame when the data changes (cheap dedupe)
    - Auto-reconnects the TCP socket if the slot restarts
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

# MetaTrader5 is a Windows-only Python C-extension. It is NOT importable
# from the host (Linux) Python — the script is run under wine where the
# package is installed in C:\\Python39\\Lib\\site-packages. If we can't
# import, we fall back to a heartbeat-only mode that publishes
# last_error so the slot knows the publisher is alive but can't see MT5.
try:
    import MetaTrader5 as mt5  # type: ignore
    HAS_MT5 = True
except ImportError as e:
    mt5 = None  # type: ignore
    HAS_MT5 = False
    IMPORT_ERROR = repr(e)

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("mt5-account-publisher")

SLOT_HOST = os.environ.get("SLOT_MT5_TCP_HOST", "127.0.0.1")
SLOT_PORT = int(os.environ.get("SLOT_MT5_TCP_PORT", "7778"))
POLL_SECS = float(os.environ.get("MT5_ACCOUNT_POLL_SECS", "1.5"))
INIT_RETRY_SECS = float(os.environ.get("MT5_INIT_RETRY_SECS", "5.0"))
INIT_TIMEOUT_SECS = float(os.environ.get("MT5_INIT_TIMEOUT_SECS", "60.0"))

_stop = False
_mt5_ready = False


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


def normalize_account(info: Any) -> dict[str, Any]:
    """Extract the fields the slot's Mt5Connector cares about."""
    return {
        "logged_in": True,
        "login": int(getattr(info, "login", 0) or 0),
        "server": str(getattr(info, "server", "") or ""),
        "balance": float(getattr(info, "balance", 0.0) or 0.0),
        "equity": float(getattr(info, "equity", 0.0) or 0.0),
    }


def try_init_mt5() -> bool:
    """Try to initialize the MT5 connection once. Returns True on success."""
    if not HAS_MT5:
        return False
    try:
        ok = mt5.initialize()
        if ok:
            log.info("mt5.initialize() ok — terminal: %s", mt5.terminal_info())
            return True
        err = mt5.last_error()
        log.warning("mt5.initialize() failed: %s", err)
        return False
    except Exception as e:  # C-extension can raise on broken pipe etc.
        log.warning("mt5.initialize() raised: %s", e)
        return False


def loop() -> int:
    """Main poll loop. Returns exit code (always 0 — we restart via s6)."""
    if not HAS_MT5:
        log.error("MetaTrader5 not importable: %s", IMPORT_ERROR)
        log.error("publisher will run in heartbeat-only mode")

    client = SlotClient(SLOT_HOST, SLOT_PORT)
    last_sent: Optional[dict[str, Any]] = None
    init_started_at = time.monotonic()

    # Heartbeat so the slot knows we're alive even if MT5 isn't ready
    last_heartbeat = 0.0

    while not _stop:
        now = time.monotonic()

        if HAS_MT5 and not _mt5_ready:

            if now - init_started_at > INIT_TIMEOUT_SECS:
                # We've been retrying too long without success. Tell the
                # slot via last_error and back off the init attempt.
                if last_sent is None or last_sent.get("last_error") != "mt5-init-timeout":
                    payload = frame(
                        "account",
                        {
                            "logged_in": False,
                            "last_error": "mt5-init-timeout",
                        },
                    )
                    if client.send(payload):
                        last_sent = {"last_error": "mt5-init-timeout"}
                        log.error("mt5.initialize() did not succeed within %.0fs", INIT_TIMEOUT_SECS)

            elif try_init_mt5():
                _mt5_ready = True
                log.info("MT5 ready — entering account-info poll loop")

            else:
                # Throttle: only retry init every INIT_RETRY_SECS
                if now - last_heartbeat >= INIT_RETRY_SECS:
                    payload = frame(
                        "account",
                        {
                            "logged_in": False,
                            "last_error": "mt5-init-pending",
                        },
                    )
                    client.send(payload)  # best-effort
                    last_heartbeat = now
                time.sleep(min(POLL_SECS, INIT_RETRY_SECS))
                continue

        if HAS_MT5 and _mt5_ready:
            try:
                info = mt5.account_info()
            except Exception as e:
                log.warning("mt5.account_info() raised: %s — re-initializing", e)
                _mt5_ready = False
                init_started_at = time.monotonic()
                try:
                    mt5.shutdown()
                except Exception:
                    pass
                continue

            if info is None:
                # User logged out (or never logged in). Publish
                # logged_in=false if we previously said true.
                if last_sent is None or last_sent.get("logged_in") is not False:
                    payload = frame("account", {"logged_in": False})
                    if client.send(payload):
                        last_sent = {"logged_in": False}
                        log.info("MT5 account_info() is None — published logged_in=false")
            else:
                data = normalize_account(info)
                if data != last_sent:
                    payload = frame("account", data)
                    if client.send(payload):
                        last_sent = data
                        log.info(
                            "published account: login=%s server=%s balance=%.2f equity=%.2f",
                            data["login"], data["server"], data["balance"], data["equity"],
                        )

        # Heartbeat every 30s — keep the TCP socket warm and signal liveness
        elif now - last_heartbeat >= 30.0:
            payload = frame("startup", {})
            if client.send(payload):
                last_heartbeat = now

        # Sleep in small slices so SIGTERM is responsive
        slept = 0.0
        while slept < POLL_SECS and not _stop:
            time.sleep(min(0.2, POLL_SECS - slept))
            slept += 0.2

    client.close()
    log.info("publisher loop exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(loop())