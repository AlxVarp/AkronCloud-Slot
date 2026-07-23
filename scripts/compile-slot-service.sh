#!/bin/bash
# Compile mql5/SlotService.mq5 to SlotService.ex5 inside the akron-mt5-base
# wineprefix using xvfb + wine + metaeditor64.exe. Run during the Docker
# build stage (specifically the runtime stage FROM akron-mt5-base, which
# has Wine + MetaTrader + metaeditor64.exe pre-installed).
#
# Why a script: Dockerfile RUN with the metaeditor /compile: arg requires
# backslash-escaping the "Program Files" path with spaces. That escaping
# inside a Dockerfile line is unreadable. Pulling the command into a
# plain shell script avoids the mess.

set -eu

# MQL5 install paths (inside akron-mt5-base wineprefix)
SRC_MQ5='/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Services/SlotService.mq5'
DEST_EX5='/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Services/SlotService.ex5'
INCLUDE='/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5'
METAEDITOR='/config/.wine/drive_c/users/abc/MetaTrader 5/MetaEditor64.exe'

# Wine Z:\ mapping of the same paths (used by metaeditor64 /compile: arg)
ZMQ5='Z:\config\.wine\drive_c\Program Files\MetaTrader 5\MQL5\Services\SlotService.mq5'
ZINC='Z:\config\.wine\drive_c\Program Files\MetaTrader 5\MQL5'

export DISPLAY=:99
export WINEPREFIX=/config/.wine

if [ ! -f "$SRC_MQ5" ]; then
  echo "[compile] FATAL: source .mq5 missing at $SRC_MQ5"
  exit 1
fi

# Delete any pre-existing .ex5 so the COPY later picks up the freshly built one
rm -f "$DEST_EX5"

# Launch virtual display and run metaeditor64.exe /compile
xvfb-run -a --server-args='-screen 0 1024x768x24' \
  wine "$METAEDITOR" /portable \
    /compile:"$ZMQ5" \
    /inc:"$ZINC" \
    2>&1 | tail -20 || true

# Verify result
if [ ! -f "$DEST_EX5" ]; then
  echo "[compile] FATAL: metaeditor produced no $DEST_EX5"
  exit 1
fi

SIZE=$(stat -c %s "$DEST_EX5")
echo "[compile] OK: $DEST_EX5 built ($SIZE bytes)"