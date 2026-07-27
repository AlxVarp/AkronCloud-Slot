#!/usr/bin/env bash
# Enable MT5 AutoTrading only after a broker session is fully established.
#
# MT5 build 5836 can reset this interactive preference when the broker profile
# is created.  Running UI automation while the login wizard is open steals
# focus, so this guard first requires a real account_info() response and a
# quiet MT5 main window.  It never places an order.
set -u

LOG=/var/log/ensure-autotrading.log
WINE=/opt/wine-stable/bin/wine
PY=/config/.wine/drive_c/Python39/python.exe

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

runtime_state() {
  s6-setuidgid abc env WINEPREFIX=/config/.wine WINEDEBUG=-all HOME=/config \
    XDG_RUNTIME_DIR=/config/.XDG DISPLAY=:0 PYTHONHASHSEED=0 \
    "$WINE" "$PY" -c \
    'import MetaTrader5 as m; ok=m.initialize(timeout=3000); t=m.terminal_info() if ok else None; a=m.account_info() if ok else None; print("1" if t and a and t.connected and t.trade_allowed else "0", "1" if a else "0")' \
    2>/dev/null | tail -n 1 | tr -d '\r' || true
}

terminal_is_idle() {
  local active main
  active=$(s6-setuidgid abc env DISPLAY=:0 xdotool getactivewindow 2>/dev/null || true)
  main=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name 'MetaTrader 5' 2>/dev/null | tail -n 1 || true)
  [[ -n "$active" && "$active" == "$main" ]]
}

enable_with_ui() {
  local mt5 options X Y WIDTH HEIGHT
  mt5=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name 'MetaTrader 5' 2>/dev/null | tail -n 1 || true)
  [[ -n "$mt5" ]] || return 1
  s6-setuidgid abc env DISPLAY=:0 xdotool windowactivate --sync "$mt5" key Escape key ctrl+o
  sleep 1
  options=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^Options$' 2>/dev/null | tail -n 1 || true)
  [[ -n "$options" ]] || return 1
  eval "$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowgeometry --shell "$options")"
  # Use the actual window geometry rather than fixed desktop coordinates.
  # Wine may reposition a modal after it is activated.
  s6-setuidgid abc env DISPLAY=:0 xdotool windowactivate --sync "$options"
  s6-setuidgid abc env DISPLAY=:0 xdotool mousemove "$((X + 185))" "$((Y + 41))" click 1
  sleep 0.4
  # Expert Advisors: first checkbox, then OK.  We enter only after the
  # runtime API confirmed trading is off, so this is an enable operation.
  s6-setuidgid abc env DISPLAY=:0 xdotool mousemove "$((X + 36))" "$((Y + 76))" click 1
  sleep 0.2
  s6-setuidgid abc env DISPLAY=:0 xdotool mousemove "$((X + WIDTH - 207))" "$((Y + HEIGHT - 18))" click 1
}

log 'post-login AutoTrading guard started'
while true; do
  read -r enabled account <<<"$(runtime_state)"
  if [[ "$enabled" == 1 ]]; then sleep 20; continue; fi
  # Never manipulate MT5 before an account exists or while a dialog owns
  # focus; this is the key difference from the old pre-login guard.
  if [[ "$account" == 1 ]] && terminal_is_idle; then
    if enable_with_ui; then
      sleep 3
      read -r enabled _ <<<"$(runtime_state)"
      [[ "$enabled" == 1 ]] && log 'AutoTrading enabled after broker login' || log 'AutoTrading UI attempt did not take; retrying later'
    fi
  fi
  sleep 15
done
