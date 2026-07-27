#!/usr/bin/env bash
# Keep MT5's terminal-wide AutoTrading option enabled after a desktop login.
#
# MT5 build 5836 stores this preference in the interactive user profile and
# can reset it when a fresh account profile is created.  terminal.ini and the
# Wine registry default it to enabled, but neither is authoritative after the
# first login.  The Python API exposes the authoritative runtime flag as
# terminal_info().trade_allowed; when it is false we use the same Options /
# Expert Advisors UI a human would use to enable it.  No order is sent here.

set -u

LOG=/var/log/ensure-autotrading.log
WINE=/opt/wine-stable/bin/wine
PY=/config/.wine/drive_c/Python39/python.exe

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

terminal_allows_trading() {
  local state
  state=$(s6-setuidgid abc env \
    WINEPREFIX=/config/.wine WINEDEBUG=-all HOME=/config \
    XDG_RUNTIME_DIR=/config/.XDG DISPLAY=:0 PYTHONHASHSEED=0 \
    "$WINE" "$PY" -c \
    'import MetaTrader5 as m; print("1" if m.initialize(timeout=3000) and m.terminal_info() and m.terminal_info().trade_allowed else "0")' \
    2>/dev/null | tail -n 1 || true)
  [[ "$state" == '1' ]]
}

enable_with_ui() {
  local mt5 options x y width height
  mt5=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name 'Deriv-Demo|MetaTrader 5' 2>/dev/null | tail -n 1 || true)
  [[ -n "$mt5" ]] || return 1

  # Close a stale menu/dialog, then open Tools -> Options. Ctrl+O is the
  # documented MT5 shortcut; the Tools-menu fallback covers Wine builds that
  # swallow the shortcut while a chart has focus.
  s6-setuidgid abc env DISPLAY=:0 xdotool windowactivate --sync "$mt5" key Escape key ctrl+o
  sleep 1
  options=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^Options$' 2>/dev/null | tail -n 1 || true)
  if [[ -z "$options" ]]; then
    s6-setuidgid abc env DISPLAY=:0 xdotool mousemove 216 40 click 1
    sleep 0.2
    s6-setuidgid abc env DISPLAY=:0 xdotool mousemove 249 275 click 1
    sleep 1
    options=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^Options$' 2>/dev/null | tail -n 1 || true)
  fi
  [[ -n "$options" ]] || return 1

  # Server -> Charts -> Trade -> Expert Advisors. Use separate key events:
  # xdotool coalesces repeated Ctrl+Tab presses under Wine otherwise.
  s6-setuidgid abc env DISPLAY=:0 xdotool windowactivate --sync "$options" key ctrl+Tab
  sleep 0.15
  s6-setuidgid abc env DISPLAY=:0 xdotool key ctrl+Tab
  sleep 0.15
  s6-setuidgid abc env DISPLAY=:0 xdotool key ctrl+Tab
  sleep 0.4

  eval "$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowgeometry --shell "$options")"
  # First checkbox is "Allow algorithmic trading" at (35,55) relative to
  # the Options window. Click once only after the API reported it disabled.
  s6-setuidgid abc env DISPLAY=:0 xdotool mousemove "$((X + 35))" "$((Y + 55))" click 1
  sleep 0.2
  # OK is the center button along the bottom; deriving the coordinates from
  # the actual dialog geometry works with both maximized and normal dialogs.
  s6-setuidgid abc env DISPLAY=:0 xdotool mousemove "$((X + WIDTH * 2 / 3))" "$((Y + HEIGHT - 18))" click 1
}

log 'AutoTrading guard started'
while true; do
  if terminal_allows_trading; then
    sleep 20
    continue
  fi
  if enable_with_ui; then
    sleep 2
    if terminal_allows_trading; then
      log 'enabled AutoTrading through MT5 Options'
    else
      log 'AutoTrading UI action completed but runtime flag is still disabled'
    fi
  fi
  sleep 10
done
