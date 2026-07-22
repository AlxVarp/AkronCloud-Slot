#!/usr/bin/env python3
"""
inject-account-reporter — v55

Adds AccountReporter.ex5 to every MT5 chart (.chr) file under
`Profiles/Charts/Default/`. MT5's chart files are UTF-16 LE text
with a simple XML-ish format; an `<indicator>` block with
`name=AccountReporter` + `path=Indicators\\AccountReporter.ex5`
tells MT5 to auto-attach the indicator every time the chart is
restored (which happens on every MT5 boot).

Idempotent: skips any chart that already lists AccountReporter.

Why not use a chart template (.tpl)?
    Templates are user-saved snapshots; MT5 doesn't auto-load them
    unless the user explicitly picks one as "default". The .chr files
    in Profiles/Charts/Default/ are the persisted chart state — MT5
    ALWAYS restores them on boot, no user opt-in required.

Run during docker build (Dockerfile has it as a RUN step after the
AccountReporter.ex5 COPY). Idempotent, safe to re-run.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROFILES_CHARTS = Path(
    "/config/.wine/drive_c/Program Files/MetaTrader 5/Profiles/Charts"
)

# The exact <indicator> block we inject. Path uses backslash because
# that's what MT5 stores in .chr files (Windows convention).
INDICATOR_BLOCK = (
    "<indicator>\n"
    "name=AccountReporter\n"
    "path=Indicators\\AccountReporter.ex5\n"
    "apply=1\n"
    "show_data=1\n"
    "scale_inherit=0\n"
    "scale_line=0\n"
    "scale_line_percent=50\n"
    "scale_line_value=0.000000\n"
    "scale_fix_min=0\n"
    "scale_fix_min_val=0.000000\n"
    "scale_fix_max=0\n"
    "scale_fix_max_val=0.000000\n"
    "</indicator>\n"
)


def inject(path: Path) -> str:
    """Inject AccountReporter into one .chr file. Returns 'added',
    'already', or 'no-chart-block'."""
    raw = path.read_text(encoding="utf-16")
    if "name=AccountReporter" in raw:
        return "already"

    # Insert the new <indicator> right before </window> so it's part
    # of the chart's window — same placement as the built-in Moving
    # Average in the default chart01.chr.
    close_tag = "</window>"
    idx = raw.rfind(close_tag)
    if idx == -1:
        return "no-window-tag"
    new = raw[:idx] + INDICATOR_BLOCK + raw[idx:]

    # Atomic write via .tmp + rename.
    tmp = path.with_suffix(".chr.tmp")
    tmp.write_text(new, encoding="utf-16")
    tmp.replace(path)
    return "added"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profiles-charts", default=str(PROFILES_CHARTS),
                    help="Override the Profiles/Charts root (testing)")
    args = ap.parse_args()

    root = Path(args.profiles_charts)
    if not root.exists():
        print(f"profiles root not found: {root}", file=sys.stderr)
        return 1

    # Find every Default profile (one per broker profile MT5 creates).
    # .chr files for live charts live in <profile>/chartNN.chr.
    chart_files = sorted(root.glob("*/chart*.chr"))
    if not chart_files:
        print(f"no chart files under {root}", file=sys.stderr)
        return 0

    added = 0
    skipped = 0
    for path in chart_files:
        result = inject(path)
        if result == "added":
            added += 1
            print(f"  + {path.relative_to(root)} (added AccountReporter)")
        elif result == "already":
            skipped += 1
            print(f"  = {path.relative_to(root)} (already has AccountReporter)")
        else:
            print(f"  ? {path.relative_to(root)} ({result})", file=sys.stderr)

    print(f"\ninjected into {added} chart(s), {skipped} already had it")
    return 0


if __name__ == "__main__":
    sys.exit(main())