#!/usr/bin/env python3
"""Independent MT5 command server for Wine-based MT5 containers.

It deliberately runs in its own Windows Python process.  The account publisher
can block in the Wine MT5 IPC layer, which would otherwise stall command replies.
"""

import json
import logging
import socketserver
import time
from typing import Any

import MetaTrader5 as mt5


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("mt5-command-server")


def ready() -> bool:
    return bool(mt5.initialize(timeout=5000))


def trade_failed(prefix: str, result: Any) -> RuntimeError:
    return RuntimeError(
        f"{prefix}:{getattr(result, 'retcode', None)}:{getattr(result, 'comment', None)}"
    )


def run(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not ready():
        raise RuntimeError("mt5_not_ready")

    if action == "account":
        info = mt5.account_info()
        if info is None:
            raise RuntimeError("account_unavailable")
        return info._asdict()

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
        names = [s.name for s in (mt5.symbols_get() or ()) if not pattern or pattern in s.name.lower()]
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
        volume = float(payload.get("volume") or payload.get("qty") or 0)
        if not symbol or side not in ("buy", "sell") or volume <= 0:
            raise RuntimeError("invalid_open_payload")
        if not mt5.symbol_select(symbol, True):
            raise RuntimeError("symbol_select_failed")
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("quote_unavailable")
        is_buy = side == "buy"
        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
            "price": tick.ask if is_buy else tick.bid,
            "deviation": int(payload.get("deviation") or 10),
            "sl": float(payload.get("sl") or 0),
            "tp": float(payload.get("tp") or 0),
            "comment": str(payload.get("comment") or "akroncloud"),
            "type_filling": mt5.ORDER_FILLING_FOK,
        })
        if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
            raise trade_failed("order_send_failed", result)
        return {
            "order_id": str(result.order),
            "broker_order_id": str(result.order),
            "deal": str(result.deal),
        }

    if action == "close":
        ticket = int(payload.get("position_id") or payload.get("ticket") or 0)
        positions = mt5.positions_get(ticket=ticket) or ()
        if not positions:
            raise RuntimeError("position_not_found")
        position = positions[0]
        tick = mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise RuntimeError("quote_unavailable")
        volume = float(payload.get("qty") or payload.get("volume") or position.volume)
        is_buy = position.type == mt5.POSITION_TYPE_BUY
        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL,
            "position": ticket,
            "symbol": position.symbol,
            "volume": volume,
            "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
            "price": tick.bid if is_buy else tick.ask,
            "deviation": int(payload.get("deviation") or 10),
            "type_filling": mt5.ORDER_FILLING_FOK,
        })
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise trade_failed("close_failed", result)
        return {"closed_ticket": str(result.order), "broker_order_id": str(result.order), "position_id": str(ticket)}

    if action == "cancel":
        ticket = int(payload.get("order_id") or payload.get("ticket") or 0)
        result = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise trade_failed("cancel_failed", result)
        return {"canceled": str(ticket), "cancelled": True}

    if action in ("sltp", "modify_position"):
        ticket = int(payload.get("position_id") or payload.get("order_id") or payload.get("ticket") or 0)
        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "sl": float(payload.get("sl") or 0),
            "tp": float(payload.get("tp") or 0),
        })
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise trade_failed("modify_failed", result)
        return {"modified": True, "position_id": str(ticket), "sl": float(payload.get("sl") or 0), "tp": float(payload.get("tp") or 0)}

    raise RuntimeError(f"unsupported_action:{action}")


class CommandHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        for raw in self.rfile:
            try:
                request = json.loads(raw.decode("utf-8"))
                if request.get("type") not in (None, "command"):
                    continue
                response: dict[str, Any] = {"type": "response", "id": request.get("id")}
                try:
                    response.update(ok=True, result=run(str(request.get("action") or ""), request.get("payload") or {}))
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


if __name__ == "__main__":
    server = CommandServer(("127.0.0.1", 7780), CommandHandler)
    log.info("MT5 command server listening on 127.0.0.1:7780")
    server.serve_forever()
