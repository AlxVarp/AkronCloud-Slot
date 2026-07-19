#!/usr/bin/env python3
"""
mt5-bridge-adapter — translates between the slot's ZMQ protocol
(tcp://*:5556 inbound commands, tcp://*:5557 outbound events) and
the akron-mt5-base's mt5copy_bridge HTTP API (http://127.0.0.1:8003).

The bridge runs INSIDE the slot container (started by /Metatrader/start.sh
which sets up Python embed + mt5linux + bridge in operational profile).
The bridge is a Python process inside wine that talks to MT5 via the
mt5linux rpyc protocol; it exposes a small HTTP API to the outside
world (action = open / close / positions / runtime / etc.) so we don't
need MT5's "Allow services" toggle or a running MQL5 service.

This adapter replaces what the now-deprecated SlotService.mq5 +
PublisherZMQEvents.ex5 pipeline used to do: the slot's Mt5Connector
publishes commands on ZMQ 5556 and expects fills + order_state +
account events on ZMQ 5557. The adapter consumes the same shapes.

Usage:
  BRIDGE_URL=http://127.0.0.1:8003 \
  ZMQ_CMD_ENDPOINT=tcp://*:5556 \
  ZMQ_EVT_ENDPOINT=tcp://*:5557 \
  POLL_INTERVAL_MS=500 \
  python3 src/services/mt5-bridge-adapter.py
"""
import json
import logging
import os
import sys
import time
from threading import Thread

import urllib.request
import urllib.error

import zmq

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8003").rstrip("/")
ZMQ_CMD_ENDPOINT = os.environ.get("ZMQ_CMD_ENDPOINT", "tcp://*:5556")
ZMQ_EVT_ENDPOINT = os.environ.get("ZMQ_EVT_ENDPOINT", "tcp://*:5557")
POLL_INTERVAL_MS = int(os.environ.get("POLL_INTERVAL_MS", "500"))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s bridge-adapter %(message)s",
)
log = logging.getLogger("bridge-adapter")


# ───────────────────────── HTTP bridge client ─────────────────────────

def http_post(path: str, body: dict, timeout: float = 5.0) -> dict:
    """POST JSON to the bridge and return the parsed response."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(path: str, timeout: float = 3.0) -> dict:
    """GET from the bridge and return the parsed response."""
    with urllib.request.urlopen(f"{BRIDGE_URL}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def bridge_health() -> dict:
    try:
        return http_get("/health", timeout=2.0)
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": repr(exc)}


def bridge_action(action: str, payload: dict) -> dict:
    return http_post("/action", {"action": action, "payload": payload})


# ───────────────────────── state cache + diff → events ─────────────────────────

_cache = {
    "loggedIn": False,
    "balance": 0.0,
    "equity": 0.0,
    "margin": 0.0,
    "positions": {},  # by position id
    "orders": {},     # by order id
}


def _positions_snapshot() -> dict:
    """Pull current positions, return {pos_id: pos_dict}."""
    res = bridge_action("positions", {})
    if not res.get("ok"):
        return {}
    out = {}
    for p in res.get("positions", []) or []:
        pid = str(p.get("id") or p.get("ticket") or p.get("comment") or "")
        if not pid:
            continue
        out[pid] = {
            "id": pid,
            "account_id": p.get("account_id"),
            "instrument": p.get("symbol") or p.get("instrument"),
            "side": "long" if (p.get("type") or "").lower().startswith("buy") or p.get("side") == "long" else "short",
            "qty": float(p.get("volume") or p.get("qty") or 0),
            "avg_price": float(p.get("price_open") or p.get("price") or 0),
            "mark_price": float(p.get("price_current") or p.get("price") or 0),
        }
    return out


def _orders_snapshot() -> dict:
    res = bridge_action("orders", {})
    if not res.get("ok"):
        return {}
    out = {}
    for o in res.get("orders", []) or []:
        oid = str(o.get("id") or o.get("ticket") or o.get("comment") or "")
        if not oid:
            continue
        out[oid] = {
            "id": oid,
            "account_id": o.get("account_id"),
            "instrument": o.get("symbol") or o.get("instrument"),
            "side": o.get("side") or ("buy" if (o.get("type") or "").lower().startswith("buy") else "sell"),
            "qty": float(o.get("volume_initial") or o.get("volume") or 0),
            "type": o.get("type"),
            "price": o.get("price_open"),
            "status": (o.get("state") or "pending").lower(),
        }
    return out


def _account_state() -> dict:
    """Pull account snapshot (balance, equity, margin, logged_in)."""
    res = bridge_action("runtime", {"includeDeals": False, "includeSymbols": False})
    info = res.get("info") or res.get("account") or {}
    return {
        "loggedIn": bool(info.get("trade_allowed") or info.get("logged_in") or res.get("ok")),
        "balance": float(info.get("balance") or 0),
        "equity": float(info.get("equity") or 0),
        "margin": float(info.get("margin") or 0),
    }


def _diff_and_emit(emit):
    """Compare current state to cache, emit events on diff, update cache."""
    global _cache
    try:
        acct = _account_state()
    except Exception as exc:
        log.debug("account_state error: %s", exc)
        return
    if (
        acct["loggedIn"] != _cache["loggedIn"]
        or abs(acct["balance"] - _cache["balance"]) > 1e-6
        or abs(acct["equity"] - _cache["equity"]) > 1e-6
    ):
        if acct["loggedIn"] and not _cache["loggedIn"]:
            emit({"kind": "account", "data": {"kind": "login"}})
        if not acct["loggedIn"] and _cache["loggedIn"]:
            emit({"kind": "account", "data": {"kind": "logout"}})
        _cache["loggedIn"] = acct["loggedIn"]
        _cache["balance"] = acct["balance"]
        _cache["equity"] = acct["equity"]
        _cache["margin"] = acct["margin"]

    # positions
    try:
        new_pos = _positions_snapshot()
    except Exception as exc:
        log.debug("positions error: %s", exc)
        new_pos = {}
    old_pos = _cache["positions"]
    for pid, p in new_pos.items():
        if pid not in old_pos:
            emit({"kind": "fill", "data": {
                "broker_order_id": pid,
                "symbol": p["instrument"],
                "qty": p["qty"],
                "price": p["avg_price"],
                "ts": int(time.time() * 1000),
            }})
            emit({"kind": "order_state", "data": {
                "order_id": pid,
                "status": "filled",
            }})
    _cache["positions"] = new_pos

    # orders
    try:
        new_orders = _orders_snapshot()
    except Exception as exc:
        log.debug("orders error: %s", exc)
        new_orders = {}
    old_orders = _cache["orders"]
    for oid, o in new_orders.items():
        prev = old_orders.get(oid)
        if prev is None or prev.get("status") != o["status"]:
            emit({"kind": "order_state", "data": {
                "order_id": oid,
                "status": o["status"],
            }})
    _cache["orders"] = new_orders


def poller_loop(emit):
    """Every POLL_INTERVAL_MS, fetch state from bridge and emit events."""
    while True:
        _diff_and_emit(emit)
        time.sleep(POLL_INTERVAL_MS / 1000.0)


# ───────────────────────── ZMQ command handling ─────────────────────────

def handle_command(msg: dict) -> dict:
    """Execute a slot command against the bridge and return a result dict."""
    t = msg.get("type")
    try:
        if t == "login":
            # bridge assumes MT5 is already logged in; we just verify
            # health and return ok so the slot's validator can flip
            # the account to active. Real login happens in the KasmVNC.
            h = bridge_health()
            if h.get("ok"):
                return {"ok": True, "accountRef": f"mt5-{msg.get('server')}-{msg.get('login')}"}
            return {"ok": False, "reason": "bridge_unavailable", "health": h}
        if t == "logout":
            # bridge doesn't track logouts (MT5 is always logged in)
            return {"ok": True}
        if t == "place_order":
            payload = {
                "instrument": msg.get("instrument"),
                "side": msg.get("side"),
                "qty": msg.get("qty"),
                "order_type": msg.get("order_type", "market"),
                "price": msg.get("price"),
                "sl": msg.get("sl"),
                "tp": msg.get("tp"),
                "comment": msg.get("client_order_id", ""),
            }
            res = bridge_action("open", payload)
            broker_id = (res.get("ticket") or res.get("id") or
                         msg.get("client_order_id", ""))
            return {
                "ok": bool(res.get("ok")),
                "order_id": msg.get("client_order_id"),
                "broker_order_id": str(broker_id),
            }
        if t == "close_position":
            payload = {
                "ticket": int(msg.get("position_id", 0)) if str(msg.get("position_id", "")).isdigit() else msg.get("position_id"),
                "qty": msg.get("qty"),
            }
            res = bridge_action("close", payload)
            return {"ok": bool(res.get("ok")), "result": res}
        return {"ok": False, "reason": "unsupported_type", "type": t}
    except Exception as exc:
        return {"ok": False, "reason": "bridge_error", "error": repr(exc)}


def zmq_command_loop(cmd_sock, evt_sock):
    """Receive ZMQ commands, execute, no reply (events go via evt_sock)."""
    log.info("ZMQ command loop started on %s", ZMQ_CMD_ENDPOINT)
    while True:
        try:
            raw = cmd_sock.recv()
        except Exception as exc:
            log.warning("cmd recv error: %s; reconnecting", exc)
            time.sleep(1.0)
            continue
        try:
            msg = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            log.warning("bad json on cmd socket: %s", exc)
            continue
        result = handle_command(msg)
        log.info("cmd %s -> %s", msg.get("type"), result.get("ok"))


def main():
    log.info("starting bridge-adapter: bridge=%s cmd=%s evt=%s poll=%dms",
             BRIDGE_URL, ZMQ_CMD_ENDPOINT, ZMQ_EVT_ENDPOINT, POLL_INTERVAL_MS)

    # wait for bridge to be reachable (start.sh takes 2-3 min on first boot)
    deadline = time.time() + 600
    while time.time() < deadline:
        h = bridge_health()
        if h.get("ok"):
            log.info("bridge healthy: %s", h)
            break
        log.info("bridge not ready yet: %s", h)
        time.sleep(5.0)
    else:
        log.warning("bridge did not become healthy in 10 min; "
                    "continuing anyway (events will be no-op until it does)")

    ctx = zmq.Context.instance()

    # PUB side (events) — bind on 5557 (the slot's mt5-zmq.ts
    # is a SUB that connects to this port and parses the same
    # JSON event shapes the old PublisherZMQEvents.ex5 used).
    evt_sock = ctx.socket(zmq.PUB)
    evt_sock.bind(ZMQ_EVT_ENDPOINT)
    log.info("PUB events bound on %s", ZMQ_EVT_ENDPOINT)

    # SUB side (commands) — connect to 5556. The slot's Mt5Connector
    # is a PUB that BINDs on 5556 (zeromq Publisher). We SUBSCRIBE to
    # those commands and forward each one to the bridge via HTTP. The
    # previous design (PULL on 5556) collided with the slot's PUB
    # binding the same port.
    cmd_sock = ctx.socket(zmq.SUB)
    cmd_sock.connect(ZMQ_CMD_ENDPOINT)
    cmd_sock.setsockopt_string(zmq.SUBSCRIBE, "")  # all messages
    log.info("SUB commands connected to %s", ZMQ_CMD_ENDPOINT)

    # emit() writes events to ZMQ PUB
    def emit(event: dict):
        evt_sock.send_string(json.dumps(event))
        log.debug("emit %s", event)

    # start the poller (emits events on diff)
    Thread(target=poller_loop, args=(emit,), daemon=True).start()

    # main thread: consume ZMQ commands
    zmq_command_loop(cmd_sock, evt_sock)


if __name__ == "__main__":
    main()
