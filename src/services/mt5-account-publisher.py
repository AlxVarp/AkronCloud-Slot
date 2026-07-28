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
import socketserver
import sys
import threading
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
TRADE_EVENT_POLL_SECS = float(os.environ.get("MT5_TRADE_EVENT_POLL_SECS", "0.075"))
INIT_RETRY_SECS = float(os.environ.get("MT5_INIT_RETRY_SECS", "5.0"))
INIT_TIMEOUT_SECS = float(os.environ.get("MT5_INIT_TIMEOUT_SECS", "60.0"))
COMMAND_HOST = os.environ.get("SLOT_MT5_CMD_BIND", "127.0.0.1")
COMMAND_PORT = int(os.environ.get("SLOT_MT5_CMD_PORT", "7780"))
COMMAND_SERVER_ENABLED = os.environ.get("MT5_COMMAND_SERVER_ENABLED", "1") == "1"

# After this many consecutive `mt5.account_info() → None` polls, the
# publisher assumes the IPC connection silently died (MT5 broker
# re-auth, wine hiccup, slot broker-login flow interference) and
# forces re-initialization. At POLL_SECS=1.5s, default=10 means we
# wait ~15s of bad readings before re-init — long enough to
# distinguish a real logout from a transient IPC blip, short enough
# to recover automatically within the user's normal attention span.
MAX_NONE_STREAK = int(os.environ.get("MT5_MAX_NONE_STREAK", "10"))

_stop = False
_mt5_ready = False
_none_streak = 0


def command_result(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Execute the SlotService command wire protocol through MT5's Python API.

    MT5 build 5836 under Wine does not reliably auto-start MQL5 Services.
    Keeping this endpoint alongside the already-running publisher makes the
    command channel independent of the MQL5 service lifecycle.
    """
    if not HAS_MT5 or not _mt5_ready:
        raise RuntimeError("mt5_not_ready")

    if action == "account":
        info = mt5.account_info()
        if info is None:
            raise RuntimeError("account_unavailable")
        fields = ("login", "server", "currency", "name", "company", "leverage",
                  "trade_allowed", "balance", "equity", "margin", "margin_free",
                  "margin_level", "profit")
        return {key: getattr(info, key, None) for key in fields}

    if action == "positions":
        positions = mt5.positions_get() or ()
        return {"count": len(positions), "positions": [p._asdict() for p in positions]}

    if action == "orders":
        orders = mt5.orders_get() or ()
        return {"count": len(orders), "orders": [o._asdict() for o in orders]}

    if action in ("quote", "symbol"):
        symbol = str(payload.get("symbol") or payload.get("instrument") or "")
        if not symbol:
            raise RuntimeError("missing_symbol")
        mt5.symbol_select(symbol, True)
        info = mt5.symbol_info(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if info is None:
            raise RuntimeError("symbol_not_found")
        result = info._asdict()
        if tick is not None:
            result.update(tick._asdict())
        return result

    if action == "symbols":
        pattern = str(payload.get("pattern") or "").lower()
        symbols = mt5.symbols_get() or ()
        names = [s.name for s in symbols if not pattern or pattern in s.name.lower()]
        return {"count": len(names), "symbols": names}

    if action == "history":
        end = float(payload.get("to") or time.time())
        start = float(payload.get("from") or (end - 86400))
        deals = mt5.history_deals_get(start, end) or ()
        limit = min(max(int(payload.get("limit") or 500), 1), 5000)
        return {"count": min(len(deals), limit), "history": [d._asdict() for d in deals[-limit:]]}

    if action == "open":
        symbol = str(payload.get("symbol") or payload.get("instrument") or "")
        side = str(payload.get("side") or "").lower()
        volume = float(payload.get("volume") or 0)
        if not symbol or side not in ("buy", "sell") or volume <= 0:
            raise RuntimeError("invalid_open_payload")
        if not mt5.symbol_select(symbol, True):
            raise RuntimeError("symbol_select_failed")
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("quote_unavailable")
        request = {"action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": volume,
                   "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                   "price": tick.ask if side == "buy" else tick.bid,
                   "deviation": int(payload.get("deviation") or 10),
                   "sl": float(payload.get("sl") or 0), "tp": float(payload.get("tp") or 0),
                   "comment": str(payload.get("comment") or "akroncloud")}
        result = mt5.order_send(request)
        if result is None or getattr(result, "retcode", 0) not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
            raise RuntimeError("order_send_failed")
        return {"order_id": str(result.order), "broker_order_id": str(result.order), "deal": str(result.deal)}

    if action == "cancel":
        ticket = int(payload.get("order_id") or payload.get("ticket") or 0)
        result = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})
        if result is None or getattr(result, "retcode", 0) != mt5.TRADE_RETCODE_DONE:
            raise RuntimeError("cancel_failed")
        return {"canceled": str(ticket)}

    raise RuntimeError("unsupported_action:" + action)


class CommandHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        for raw in self.rfile:
            try:
                request = json.loads(raw.decode("utf-8"))
                if request.get("type") != "command":
                    continue
                response: dict[str, Any] = {"type": "response", "id": request.get("id")}
                try:
                    response.update(ok=True, result=command_result(str(request.get("action") or ""), request.get("payload") or {}))
                except Exception as exc:
                    log.warning("command %s failed: %s", request.get("action"), exc)
                    response.update(ok=False, error=str(exc))
                self.wfile.write((json.dumps(response, separators=(",", ":"), default=str) + "\n").encode("utf-8"))
                self.wfile.flush()
            except Exception as exc:
                log.warning("invalid command frame: %s", exc)


class CommandServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_command_server() -> CommandServer:
    server = CommandServer((COMMAND_HOST, COMMAND_PORT), CommandHandler)
    threading.Thread(target=server.serve_forever, name="mt5-command-server", daemon=True).start()
    log.info("MT5 Python command server listening on %s:%d", COMMAND_HOST, COMMAND_PORT)
    return server


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


class TradeEventPublisher:
    """Publish external MT5 order/position deltas without MQL5 Services."""

    def __init__(self) -> None:
        self.orders: Optional[dict[str, dict[str, Any]]] = None
        self.positions: Optional[dict[str, dict[str, Any]]] = None

    @staticmethod
    def _order(row: Any) -> dict[str, Any]:
        return {
            "order_id": str(getattr(row, "ticket", "")),
            "symbol": str(getattr(row, "symbol", "")),
            "order_state": int(getattr(row, "state", 0) or 0),
            "order_type": int(getattr(row, "type", 0) or 0),
            "volume": float(getattr(row, "volume_current", 0) or 0),
            "price": float(getattr(row, "price_open", 0) or 0),
            "sl": float(getattr(row, "sl", 0) or 0),
            "tp": float(getattr(row, "tp", 0) or 0),
        }

    @staticmethod
    def _position(row: Any) -> dict[str, Any]:
        return {
            "position_id": str(getattr(row, "ticket", "")),
            "symbol": str(getattr(row, "symbol", "")),
            "volume": float(getattr(row, "volume", 0) or 0),
            "price": float(getattr(row, "price_open", 0) or 0),
            "sl": float(getattr(row, "sl", 0) or 0),
            "tp": float(getattr(row, "tp", 0) or 0),
        }

    def poll(self, client: SlotClient, account: dict[str, Any]) -> None:
        try:
            raw_orders = mt5.orders_get()
            raw_positions = mt5.positions_get()
        except Exception as exc:
            log.warning("trade event poll failed: %s", exc)
            return
        # None means the terminal call failed; never treat it as an empty
        # snapshot because that would falsely publish cancellations/closes.
        if raw_orders is None or raw_positions is None:
            return
        orders = {str(row.ticket): self._order(row) for row in raw_orders}
        positions = {str(row.ticket): self._position(row) for row in raw_positions}
        if self.orders is None or self.positions is None:
            self.orders, self.positions = orders, positions
            log.info("trade event baseline captured: orders=%d positions=%d", len(orders), len(positions))
            return

        identity = {"login": account["login"], "server": account["server"]}

        for ticket, current in orders.items():
            previous = self.orders.get(ticket)
            if previous is None:
                client.send(frame("order_state", {**identity, **current, "status": "pending", "event": "created"}))
            elif previous != current:
                client.send(frame("order_state", {**identity, **current, "status": "pending", "event": "updated"}))
        for ticket, previous in self.orders.items():
            if ticket not in orders:
                client.send(frame("order_state", {**identity, **previous, "status": "cancelled", "event": "deleted"}))

        for ticket, current in positions.items():
            previous = self.positions.get(ticket)
            if previous is None or previous != current:
                client.send(frame("position", {**identity, **current, "event": "opened" if previous is None else "updated"}))
        for ticket, previous in self.positions.items():
            if ticket not in positions:
                client.send(frame("position", {**identity, **previous, "event": "closed"}))
        self.orders, self.positions = orders, positions


def try_init_mt5() -> bool:
    """Try to initialize the MT5 connection once. Returns True on success."""
    if not HAS_MT5:
        return False
    try:
        # The MetaTrader5 extension holds Python's GIL while waiting for
        # Wine IPC. Bound the wait so the command-server thread can still
        # return `mt5_not_ready` instead of making TCP clients time out.
        ok = mt5.initialize(timeout=5000)
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
    # _mt5_ready / _stop are module globals but Python's scoping rules
    # treat any name that is *assigned* anywhere in a function as a
    # local variable throughout that function. Without the `global`
    # declaration the first read of `_mt5_ready` (before any
    # assignment) raises UnboundLocalError, killing the service.
    global _mt5_ready, _none_streak

    log.info(
        "publisher starting (slot=%s:%d, poll=%.1fs, init_timeout=%.0fs, mt5_available=%s)",
        SLOT_HOST, SLOT_PORT, POLL_SECS, INIT_TIMEOUT_SECS, HAS_MT5,
    )
    if not HAS_MT5:
        log.error("MetaTrader5 not importable: %s", IMPORT_ERROR)
        log.error("publisher will run in heartbeat-only mode")

    command_server = start_command_server() if COMMAND_SERVER_ENABLED else None
    client = SlotClient(SLOT_HOST, SLOT_PORT)
    trade_events = TradeEventPublisher()
    last_sent: Optional[dict[str, Any]] = None
    init_started_at = time.monotonic()

    # Heartbeat so the slot knows we're alive even if MT5 isn't ready
    last_heartbeat = 0.0

    while not _stop:
        now = time.monotonic()

        if HAS_MT5 and not _mt5_ready:

            # Always try to init, every iteration. The C-extension is
            # idempotent: calling mt5.initialize() repeatedly while
            # not yet connected is safe. The previous version stopped
            # trying after INIT_TIMEOUT_SECS elapsed, which left the
            # publisher stuck in heartbeat-only mode forever — even
            # when MT5 became ready much later.
            if try_init_mt5():
                _mt5_ready = True
                log.info("MT5 ready — entering account-info poll loop")

            else:
                # Pick the right last_error message based on how long
                # we've been trying. The first INIT_TIMEOUT_SECS of
                # failure we call it "pending" (transient); after that
                # we call it "timeout" but keep retrying.
                elapsed = now - init_started_at
                err_msg = "mt5-init-timeout" if elapsed > INIT_TIMEOUT_SECS else "mt5-init-pending"

                # Throttle publishes to once every INIT_RETRY_SECS, and
                # dedupe so we don't spam the slot with the same message.
                if now - last_heartbeat >= INIT_RETRY_SECS:
                    if last_sent is None or last_sent.get("last_error") != err_msg:
                        payload = frame(
                            "account",
                            {"logged_in": False, "last_error": err_msg},
                        )
                        if client.send(payload):
                            last_sent = {"last_error": err_msg}
                            if err_msg == "mt5-init-timeout":
                                log.error(
                                    "mt5.initialize() has not succeeded in %.0fs — still retrying",
                                    INIT_TIMEOUT_SECS,
                                )
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
                # account_info() returned None. Two cases:
                #   1. User genuinely logged out — publish logged_in=false.
                #   2. The IPC connection silently died (MT5 broker
                #      re-auth, slot's broker-login flow, wine hiccup).
                #      In case 2, the next call also returns None — so
                #      we must re-initialize, otherwise we publish
                #      logged_in=false forever even after MT5 is back.
                #
                # Disambiguate: if account_info() returned None more
                # than once in a row, assume IPC is dead and re-init.
                # If this is the first None and it persists for
                # MAX_NONE_STREAK consecutive polls, re-init too.
                _none_streak += 1
                if last_sent is None or last_sent.get("logged_in") is not False:
                    payload = frame("account", {"logged_in": False})
                    if client.send(payload):
                        last_sent = {"logged_in": False}
                        log.info("MT5 account_info() is None — published logged_in=false")
                if _none_streak >= MAX_NONE_STREAK:
                    log.warning(
                        "account_info() returned None %d times in a row — re-initializing IPC",
                        _none_streak,
                    )
                    _mt5_ready = False
                    init_started_at = time.monotonic()
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
                    _none_streak = 0
                    continue
            else:
                _none_streak = 0
                data = normalize_account(info)
                if data != last_sent:
                    payload = frame("account", data)
                    if client.send(payload):
                        last_sent = data
                        log.info(
                            "published account: login=%s server=%s balance=%.2f equity=%.2f",
                            data["login"], data["server"], data["balance"], data["equity"],
                        )

                trade_events.poll(client, data)

        # Heartbeat every 30s — keep the TCP socket warm and signal liveness
        elif now - last_heartbeat >= 30.0:
            payload = frame("startup", {})
            if client.send(payload):
                last_heartbeat = now

        # Sleep in small slices so SIGTERM is responsive
        slept = 0.0
        sleep_for = min(POLL_SECS, TRADE_EVENT_POLL_SECS)
        while slept < sleep_for and not _stop:
            time.sleep(min(0.05, sleep_for - slept))
            slept += 0.05

    if command_server is not None:
        command_server.shutdown()
        command_server.server_close()
    client.close()
    log.info("publisher loop exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(loop())
