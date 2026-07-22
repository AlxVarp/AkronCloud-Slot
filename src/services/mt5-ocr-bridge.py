#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mt5-ocr-bridge — v56

Step 2 from docs/sessions/2026-07-22-step2-pending.md.

Reads the MT5 Trade panel via screenshot + OCR (tesseract +
ImageMagick) and publishes the result to the slot's Mt5TcpServer
over TCP 127.0.0.1:7778.

Why this exists:
    v55's MQL5 AccountReporter auto-attach via .chr injection does
    not work on this MT5 build 5836 + wine 11.0 combo (MT5 silently
    strips custom indicators from .chr state files on fresh boot).
    The user explicitly does not want any manual setup — they only
    log into MT5 and click Sync. OCR is the only path that satisfies
    that constraint: it reads whatever MT5 shows on screen, no
    MQL5 code, no .chr hacks, no template saves.

User flow:
    1. User opens http://<host>:7777/mobile in the browser.
    2. KasmVNC loads the MT5 desktop.
    3. User logs into MT5 broker normally.
    4. User clicks Sync (right-click account in Navigator → Sync, or
       the Sync button in the toolbar) — this is the standard MT5
       way to force a re-query of account state from the broker.
    5. MT5's Trade panel updates with current balance/equity.
    6. This script takes a screenshot of the MT5 main window every
       POLL_SECS, crops the bottom (Trade panel), runs tesseract,
       parses "Balance: N" and "Equity: M", publishes to the slot.

Wire protocol (same as the v55 publisher / SlotService.ex5):
    newline-delimited JSON frames
    {"type":"event","kind":"account","data":{...},"ts":<epoch_ms>}

The slot's Mt5TcpServer + Mt5Connector + app.ts resolveAccount
fallback handle the rest.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("mt5-ocr-bridge")

# Slot connection (same as mt5-state-bridge.py)
SLOT_HOST = os.environ.get("SLOT_MT5_TCP_HOST", "127.0.0.1")
SLOT_PORT = int(os.environ.get("SLOT_MT5_TCP_PORT", "7778"))
POLL_SECS = float(os.environ.get("MT5_OCR_POLL_SECS", "5"))
HEARTBEAT_S = float(os.environ.get("MT5_OCR_HEARTBEAT_S", "30"))

# Display env for X11 tools (must be set in the s6 run script, but
# we set a default for testing).
os.environ.setdefault("DISPLAY", ":0")

# MT5 main window's bottom ~150 px is the Trade panel. We crop
# dynamically based on the window's actual height (probed via
# wmctrl) so the crop survives resolution changes.
TRADE_PANEL_BOTTOM_PX = int(os.environ.get("MT5_TRADE_PANEL_BOTTOM_PX", "160"))

WORK_DIR = Path(os.environ.get("MT5_OCR_WORK_DIR", "/tmp/mt5-ocr"))
WORK_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOT_PATH = WORK_DIR / "screen.png"
TRADE_CROP_PATH = WORK_DIR / "trade.png"

# Regex patterns. tesseract output varies in casing and spacing so we
# match loosely. Numbers use '.' decimal (MT5 brokers are universal)
# and may include space as thousands separator (European locale).
BALANCE_PATTERNS = [
    re.compile(r"\bbalance[\s:]+([0-9][0-9.,\s]*[0-9.,])\b", re.IGNORECASE),
]
EQUITY_PATTERNS = [
    re.compile(r"\bequity[\s:]+([0-9][0-9.,\s]*[0-9.,])\b", re.IGNORECASE),
]
LOGIN_PATTERNS = [
    re.compile(r"\blogin[\s:#]+([0-9]{5,12})\b", re.IGNORECASE),
]
SERVER_PATTERNS = [
    re.compile(r"\bserver[\s:]+([A-Za-z][A-Za-z0-9\-_]{2,30})\b", re.IGNORECASE),
]

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


def find_mt5_window() -> Optional[tuple[str, int, int, int, int]]:
    """Find MT5 main window via wmctrl. Returns (window_id, x, y, w, h)
    or None if not found. Looks for a window whose title starts with
    'MetaTrader 5'."""
    try:
        out = subprocess.run(
            ["wmctrl", "-l", "-G"],
            capture_output=True, text=True, timeout=3,
            env={**os.environ, "DISPLAY": ":0"},
        ).stdout
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.debug("wmctrl failed: %s", e)
        return None

    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 7:
            continue
        wid, _desk, x, y, w, h = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
        # Title is everything from index 6 onwards (wmctrl -G format)
        title = " ".join(parts[6:])
        if title.startswith("MetaTrader 5"):
            try:
                return (wid, int(x), int(y), int(w), int(h))
            except ValueError:
                continue
    return None


def screenshot_mt5(window_id: str) -> bool:
    """Capture the MT5 main window to SCREENSHOT_PATH. Returns True on
    success. Uses `import -window <id>` from ImageMagick."""
    try:
        subprocess.run(
            ["import", "-window", window_id, str(SCREENSHOT_PATH)],
            check=True,
            timeout=10,
            capture_output=True,
            env={**os.environ, "DISPLAY": ":0"},
        )
        return SCREENSHOT_PATH.exists() and SCREENSHOT_PATH.stat().st_size > 0
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("screenshot failed: %s", e)
        return False


def crop_trade_panel(window_height: int) -> bool:
    """Crop the bottom TRADE_PANEL_BOTTOM_PX of the screenshot to
    TRADE_CROP_PATH. ImageMagick `convert input -crop WxH+0+Y out`."""
    crop_h = min(TRADE_PANEL_BOTTOM_PX, window_height)
    try:
        subprocess.run(
            [
                "convert", str(SCREENSHOT_PATH),
                "-crop", f"x{crop_h}+0+{window_height - crop_h}",
                "+repage",
                str(TRADE_CROP_PATH),
            ],
            check=True,
            timeout=5,
            capture_output=True,
        )
        return TRADE_CROP_PATH.exists() and TRADE_CROP_PATH.stat().st_size > 0
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("crop failed: %s", e)
        return False


def ocr_trade_panel() -> str:
    """Run tesseract on TRADE_CROP_PATH and return the OCR text."""
    try:
        result = subprocess.run(
            [
                "tesseract", str(TRADE_CROP_PATH), "stdout",
                "-l", "eng", "--psm", "6",
            ],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("tesseract failed: %s", e)
        return ""


def parse_number(s: str) -> Optional[float]:
    """Parse a number string like '1,234.56' or '1.234,56' or '9 696.32'
    or '1234.56'. Returns None on failure. Heuristic: if there's both
    ',' and '.', the rightmost is the decimal separator. Space is
    always treated as a thousands separator (matches European
    locales that MT5 sometimes inherits)."""
    s = s.strip()
    if not s:
        return None
    # Spaces are always thousands separators (European locale output).
    s = s.replace(" ", "").replace("\u00a0", "")  # also non-breaking space
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            # European: 1.234,56
            s = s.replace(".", "").replace(",", ".")
        else:
            # US: 1,234.56
            s = s.replace(",", "")
    elif "," in s:
        # Could be either thousands sep (1,234) or decimal (1,5).
        # If exactly 3 digits after the comma, treat as thousands.
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) == 3 and parts[1].isdigit():
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def parse_state(text: str) -> dict[str, Any]:
    """Extract balance, equity, login, server from OCR text. Falls back
    to logged_in=false if nothing parseable."""
    balance: Optional[float] = None
    equity: Optional[float] = None
    login: Optional[str] = None
    server: Optional[str] = None

    for pat in BALANCE_PATTERNS:
        m = pat.search(text)
        if m:
            balance = parse_number(m.group(1))
            if balance is not None:
                break

    for pat in EQUITY_PATTERNS:
        m = pat.search(text)
        if m:
            equity = parse_number(m.group(1))
            if equity is not None:
                break

    for pat in LOGIN_PATTERNS:
        m = pat.search(text)
        if m:
            login = m.group(1)
            break

    for pat in SERVER_PATTERNS:
        m = pat.search(text)
        if m:
            server = m.group(1)
            break

    # If we got a real-looking login, the user is logged in. Login
    # numbers in MT5 are typically 5-12 digits; if OCR returned
    # something outside that, treat as noise.
    logged_in = bool(login and login.isdigit() and 5 <= len(login) <= 12)

    return {
        "logged_in": logged_in,
        "login": login if logged_in else None,
        "server": server,
        "balance": balance,
        "equity": equity,
    }


def loop() -> int:
    """Main poll loop."""
    log.info(
        "starting (slot=%s:%d, poll=%.1fs, trade_panel_px=%d, work=%s)",
        SLOT_HOST, SLOT_PORT, POLL_SECS, TRADE_PANEL_BOTTOM_PX, WORK_DIR,
    )

    client = SlotClient(SLOT_HOST, SLOT_PORT)
    last_state: Optional[dict[str, Any]] = None
    last_heartbeat = 0.0
    last_window_id: Optional[str] = None
    last_window_h = 0

    while not _stop:
        now = time.monotonic()
        state: Optional[dict[str, Any]] = None

        # Locate MT5 window.
        win = find_mt5_window()
        if win is None:
            log.debug("MT5 window not found yet")
        else:
            wid, _x, _y, _w, h = win
            if (wid != last_window_id or h != last_window_h):
                log.info("MT5 window: id=%s h=%d", wid, h)
                last_window_id = wid
                last_window_h = h

            # Screenshot + crop + OCR pipeline.
            if screenshot_mt5(wid) and crop_trade_panel(h):
                text = ocr_trade_panel()
                if text:
                    state = parse_state(text)

        # Publish only on change.
        if state is not None and state != last_state:
            payload = frame("account", state)
            if client.send(payload):
                last_state = state
                log.info(
                    "published account: login=%s server=%s balance=%s equity=%s logged_in=%s",
                    state.get("login"), state.get("server"),
                    state.get("balance"), state.get("equity"),
                    state.get("logged_in"),
                )

        # Heartbeat every HEARTBEAT_S so the slot knows we're alive
        # even when state hasn't changed.
        if now - last_heartbeat >= HEARTBEAT_S:
            if client.send(frame("startup", {})):
                last_heartbeat = now

        # Sleep in small slices for responsive SIGTERM.
        slept = 0.0
        while slept < POLL_SECS and not _stop:
            time.sleep(min(0.2, POLL_SECS - slept))
            slept += 0.2

    client.close()
    log.info("ocr-bridge loop exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(loop())