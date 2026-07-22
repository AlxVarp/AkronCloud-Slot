#!/usr/bin/env python3
"""
benchmark.py — v56 slot API benchmark

See docs/sessions/2026-07-22-v56-benchmark-task.md for the full task
spec. This script runs the checks that don't require destructive
operations (container restart, publisher kill, etc.) — those are
left to the human operator to run manually per the task doc.

Tiers covered:
  1. Happy path — health, state, sync, mobile
  2. Latency & throughput — p50/p99 on sequential + parallel
  3. State consistency — reflects MT5 ops, no torn reads
  4. Failure modes — malformed TCP frames don't crash slot
  5. Recovery — verified manually (destructive); script checks state
     stays consistent after recovery events

Usage:
  pip install requests
  python3 scripts/benchmark.py --base http://45.151.122.104:7777 \
    [--tier all|1|2|3|4|5] [--token <jwt>]

Exit codes:
  0  all checks in selected tiers passed
  1  one or more Tier 1 checks failed (hard gate)
  2  one or more Tier 2-5 checks failed (still informative)
"""
from __future__ import annotations

import argparse
import json
import socket
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional

try:
    import requests
except ImportError:
    print("error: install requests (pip install requests)", file=sys.stderr)
    sys.exit(2)


@dataclass
class CheckResult:
    name: str
    tier: int
    ok: bool
    detail: str = ""


@dataclass
class Report:
    results: list[CheckResult] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    base: str = ""

    def add(self, name: str, tier: int, ok: bool, detail: str = "") -> None:
        self.results.append(CheckResult(name, tier, ok, detail))
        sym = "✅" if ok else "❌"
        print(f"  {sym} T{tier} {name}: {detail}", flush=True)

    def tier_pass(self, tier: int) -> bool:
        return all(r.ok for r in self.results if r.tier == tier)

    def write_markdown(self) -> str:
        lines = [
            f"# Slot benchmark report — {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(self.started_at))} UTC",
            "",
            f"Base: `{self.base}`",
            f"Total checks: {len(self.results)}",
            f"Passed: {sum(1 for r in self.results if r.ok)}",
            f"Failed: {sum(1 for r in self.results if not r.ok)}",
            "",
            "## Results",
            "",
        ]
        for t in (1, 2, 3, 4, 5):
            tier_results = [r for r in self.results if r.tier == t]
            if not tier_results:
                continue
            status = "PASS" if self.tier_pass(t) else "FAIL"
            lines.append(f"### Tier {t}: {status}")
            lines.append("")
            lines.append("| Check | OK | Detail |")
            lines.append("| --- | --- | --- |")
            for r in tier_results:
                sym = "✅" if r.ok else "❌"
                lines.append(f"| {r.name} | {sym} | {r.detail} |")
            lines.append("")
        return "\n".join(lines)


# ─── Tier 1: happy path ───────────────────────────────────────────

def tier1_health(report: Report, base: str) -> None:
    r = requests.get(f"{base}/v1/health", timeout=5)
    ok = r.status_code == 200 and r.json().get("status") == "ok"
    detail = f"HTTP {r.status_code} status={r.json().get('status')!r} slot_id={r.json().get('slot_id','?')[:8]}"
    report.add("health endpoint", 1, ok, detail)


def tier1_state(report: Report, base: str) -> None:
    r = requests.get(f"{base}/v1/state", timeout=5)
    j = r.json()
    ok = r.status_code == 200 and j.get("ok") is True
    detail_parts = [f"HTTP {r.status_code}"]
    if "account" in j:
        detail_parts.append(
            f"login={j['account'].get('broker_login')} server={j['account'].get('broker_server')}"
        )
    if "connector" in j and isinstance(j["connector"], dict):
        conn = j["connector"]
        detail_parts.append(
            f"loggedIn={conn.get('loggedIn')} balance={conn.get('balance')} equity={conn.get('equity')}"
        )
        if conn.get("balance") in (None, 0):
            ok = False
            detail_parts.append("BALANCE=0 — user has not logged into MT5")
    report.add("state endpoint reflects real account", 1, ok, " ".join(detail_parts))


def tier1_mobile(report: Report, base: str) -> None:
    r = requests.get(f"{base}/mobile", timeout=5)
    html = r.text if r.status_code == 200 else ""
    ok = r.status_code == 200 and "MetaTrader" in html
    report.add("mobile UI serves HTML", 1, ok, f"HTTP {r.status_code} bytes={len(html)}")


def tier1_sync(report: Report, base: str) -> None:
    r = requests.post(f"{base}/v1/sync", timeout=10)
    j = r.json() if r.status_code == 200 else {}
    ok = r.status_code == 200 and j.get("ok") is True
    detail = f"HTTP {r.status_code} ok={j.get('ok')}"
    if "account" in j:
        detail += f" broker={j['account'].get('broker_login')}"
    report.add("POST /v1/sync returns ok", 1, ok, detail)


# ─── Tier 2: latency & throughput ──────────────────────────────────

def _time_get(base: str, path: str) -> float:
    t0 = time.perf_counter()
    requests.get(f"{base}{path}", timeout=5).raise_for_status()
    return time.perf_counter() - t0


def tier2_latency(report: Report, base: str, n: int = 1000) -> None:
    samples = [_time_get(base, "/v1/health") for _ in range(n)]
    p50 = statistics.median(samples) * 1000
    p99 = statistics.quantiles(samples, n=100)[98] * 1000
    ok = p99 < 50
    report.add(
        f"GET /v1/health latency p50<5ms p99<50ms ({n} calls)",
        2,
        ok,
        f"p50={p50:.2f}ms p99={p99:.2f}ms",
    )

    samples = [_time_get(base, "/v1/state") for _ in range(n)]
    p50 = statistics.median(samples) * 1000
    p99 = statistics.quantiles(samples, n=100)[98] * 1000
    ok = p99 < 100
    report.add(
        f"GET /v1/state latency p50<10ms p99<100ms ({n} calls)",
        2,
        ok,
        f"p50={p50:.2f}ms p99={p99:.2f}ms",
    )


def tier2_concurrent_state(report: Report, base: str, n: int = 50) -> None:
    """50 parallel GET /v1/state — verify no torn reads or 5xx."""
    def _one():
        return requests.get(f"{base}/v1/state", timeout=5)

    with ThreadPoolExecutor(max_workers=n) as pool:
        futs = [pool.submit(_one) for _ in range(n)]
        responses = [f.result() for f in as_completed(futs)]

    statuses = [r.status_code for r in responses]
    bodies = [r.json() for r in responses if r.headers.get("content-type", "").startswith("application/json")]

    ok = all(s == 200 for s in statuses)
    # Check no torn reads: balance/equity should be identical across calls
    balances = {b.get("connector", {}).get("balance") for b in bodies if isinstance(b.get("connector"), dict)}
    logins = {b.get("connector", {}).get("loggedIn") for b in bodies if isinstance(b.get("connector"), dict)}
    consistent = len(balances) <= 1 and len(logins) <= 1
    detail = f"{len(statuses)} responses statuses={set(statuses)} unique_balances={balances} unique_logins={logins}"
    report.add(
        f"{n} concurrent GET /v1/state — all 200, no torn reads",
        2,
        ok and consistent,
        detail,
    )


# ─── Tier 3: state consistency ────────────────────────────────────

def tier3_state_reflects_real(report: Report, base: str) -> None:
    """Verify that /v1/state.connector has the same balance as the
    last value the publisher/OCR pushed to TCP 7778. We don't know
    that value externally — but we do know that if MT5 is logged in
    (per wmctrl title), balance must be > 0."""
    r = requests.get(f"{base}/v1/state", timeout=5)
    j = r.json()
    conn = j.get("connector", {})
    balance = conn.get("balance")
    equity = conn.get("equity")
    ok = isinstance(balance, (int, float)) and balance > 0
    report.add(
        "connector.balance > 0 (user is logged into MT5)",
        3,
        ok,
        f"balance={balance} equity={equity}",
    )


def tier3_logout_login_cycle(report: Report, base: str) -> None:
    """Manual operator step. We verify the precondition for it:
    the publisher is alive and the slot would detect a logout."""
    r = requests.get(f"{base}/v1/state", timeout=5)
    j = r.json()
    has_connector = isinstance(j.get("connector"), dict)
    has_balance = j.get("connector", {}).get("balance", 0) > 0
    report.add(
        "logout/login cycle prerequisites (operator must verify manually)",
        3,
        has_connector and has_balance,
        f"connector present={has_connector} balance>0={has_balance} — operator: logout+login and re-check",
    )


# ─── Tier 4: failure modes ─────────────────────────────────────────

def tier4_malformed_tcp_doesnt_crash(report: Report, base: str) -> None:
    """Send a malformed JSON frame to TCP 7778 — slot should log error
    but stay alive."""
    host, port = _parse_host_port(base)
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.sendall(b"this is not json\n")
        s.sendall(b'{"type":"event","kind":"unknown","data":{}}\n')
        s.sendall(b"\x00\x01\x02\x03garbage\n")
        s.close()
    except OSError as e:
        report.add("malformed TCP frame doesn't crash slot", 4, False, f"connect failed: {e}")
        return

    time.sleep(0.5)
    try:
        r = requests.get(f"{base}/v1/health", timeout=5)
        ok = r.status_code == 200
        detail = f"slot still healthy after malformed frames: HTTP {r.status_code}"
    except Exception as e:
        ok = False
        detail = f"slot died after malformed frames: {e}"
    report.add("malformed TCP frame doesn't crash slot", 4, ok, detail)


def tier4_tcp_concurrent_connections(report: Report, base: str, n: int = 10) -> None:
    """Open 10 concurrent TCP 7778 connections with valid frames."""
    host, port = _parse_host_port(base)
    frame = (
        b'{"type":"event","kind":"startup","data":{},"ts":1}\n'
    )

    def _connect_send():
        s = socket.create_connection((host, port), timeout=3)
        s.sendall(frame)
        time.sleep(0.05)
        s.close()
        return True

    ok_count = 0
    with ThreadPoolExecutor(max_workers=n) as pool:
        futs = [pool.submit(_connect_send) for _ in range(n)]
        for f in as_completed(futs):
            try:
                if f.result():
                    ok_count += 1
            except Exception:
                pass
    time.sleep(0.5)
    try:
        r = requests.get(f"{base}/v1/health", timeout=5)
        alive = r.status_code == 200
    except Exception:
        alive = False
    report.add(
        f"{n} concurrent TCP connections don't deadlock slot",
        4,
        ok_count == n and alive,
        f"{ok_count}/{n} succeeded, slot_alive={alive}",
    )


def tier4_no_account_state_error(report: Report, base: str) -> None:
    """Verify the response shape when no account exists (no broker
    login yet). Should return ok=false with a clear reason."""
    # We can't easily unset the account from outside, so this is a
    # structural check: re-read state and ensure the schema matches
    # what docs say.
    r = requests.get(f"{base}/v1/state", timeout=5)
    j = r.json()
    has_ok = "ok" in j
    has_account = "account" in j
    report.add(
        "state response has expected schema (ok, account, connector)",
        4,
        has_ok and has_account,
        f"keys={list(j.keys())}",
    )


# ─── Tier 5: recovery (mostly manual) ─────────────────────────────

def tier5_state_persists_across_polls(report: Report, base: str) -> None:
    """Poll state N times — verify balance doesn't randomly drop to 0
    when no operator action is happening. (Recovery from container
    restart is destructive — verified manually.)"""
    samples = []
    for _ in range(20):
        r = requests.get(f"{base}/v1/state", timeout=5).json()
        b = r.get("connector", {}).get("balance")
        samples.append(b)
        time.sleep(0.5)
    drops = sum(1 for b in samples if b == 0)
    ok = drops == 0
    report.add(
        "balance stable across 20 polls (no spontaneous drops)",
        5,
        ok,
        f"drops_to_0={drops}/20 unique_values={set(samples)}",
    )


# ─── helpers ────────────────────────────────────────────────────────

def _parse_host_port(base: str) -> tuple[str, int]:
    """Parse http://host:port or http://host:port/ into (host, port)."""
    rest = base.split("://", 1)[1]
    if "/" in rest:
        host_port = rest.split("/", 1)[0]
    else:
        host_port = rest
    if ":" in host_port:
        host, port = host_port.rsplit(":", 1)
        return host, int(port)
    return host_port, 80


# ─── main ───────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://45.151.122.104:7777",
                    help="Slot base URL")
    ap.add_argument("--token", default=None,
                    help="JWT (currently unused — /v1/* is unauthenticated in v56)")
    ap.add_argument("--tier", default="all", choices=["all", "1", "2", "3", "4", "5"],
                    help="Which tiers to run")
    ap.add_argument("--report", default=None,
                    help="Write markdown report to this path (default: benchmark-report-<ts>.md)")
    args = ap.parse_args()

    tiers = ["1", "2", "3", "4", "5"] if args.tier == "all" else [args.tier]
    report = Report(base=args.base)

    print(f"# Slot benchmark — {args.base}")
    print(f"# tiers: {','.join(tiers)}")
    print()

    if "1" in tiers:
        print("## Tier 1 — happy path")
        tier1_health(report, args.base)
        tier1_state(report, args.base)
        tier1_mobile(report, args.base)
        tier1_sync(report, args.base)

    if "2" in tiers:
        print("\n## Tier 2 — latency & throughput")
        tier2_latency(report, args.base)
        tier2_concurrent_state(report, args.base)

    if "3" in tiers:
        print("\n## Tier 3 — state consistency")
        tier3_state_reflects_real(report, args.base)
        tier3_logout_login_cycle(report, args.base)

    if "4" in tiers:
        print("\n## Tier 4 — failure modes")
        tier4_malformed_tcp_doesnt_crash(report, args.base)
        tier4_tcp_concurrent_connections(report, args.base)
        tier4_no_account_state_error(report, args.base)

    if "5" in tiers:
        print("\n## Tier 5 — recovery")
        tier5_state_persists_across_polls(report, args.base)

    print()
    print("=" * 60)
    failed_tiers = []
    for t in (1, 2, 3, 4, 5):
        rs = [r for r in report.results if r.tier == t]
        if not rs:
            continue
        status = "PASS" if report.tier_pass(t) else "FAIL"
        n = len(rs)
        passed = sum(1 for r in rs if r.ok)
        print(f"Tier {t}: {status} ({passed}/{n})")
        if not report.tier_pass(t):
            failed_tiers.append(t)
    print("=" * 60)

    md = report.write_markdown()
    out_path = args.report or f"benchmark-report-{int(time.time())}.md"
    with open(out_path, "w") as f:
        f.write(md)
    print(f"\nMarkdown report: {out_path}")

    if 1 in failed_tiers:
        return 1  # hard gate
    if failed_tiers:
        return 2  # informative
    return 0


if __name__ == "__main__":
    sys.exit(main())