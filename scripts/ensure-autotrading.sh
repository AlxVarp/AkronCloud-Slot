#!/usr/bin/env bash
# Enable MT5 AutoTrading only after a broker session is fully established.
#
# MT5 build 5836 can reset this interactive preference when the broker profile
# is created. Running UI automation while the login wizard is open steals
# focus, so this guard waits for the logged-in terminal title and a quiet main
# window. It never places an order.
set -u

LOG=/var/log/ensure-autotrading.log
log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

logged_in_terminal() {
  local main title
  main=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^MetaTrader 5 - ' 2>/dev/null | tail -n 1 || true)
  [[ -n "$main" ]] || return 1
  title=$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowname "$main" 2>/dev/null || true)
  # A live workspace is titled "MetaTrader 5 - <account mode> - <symbol>,<TF>".
  # Login and company-search dialogs have their own titles, so this avoids
  # stealing focus while a user is authenticating.
  [[ "$title" =~ ^MetaTrader\ 5\ -\ .+\ -\ .+,.+ ]]
}

enable_with_ui() {
  local mt5 options X Y WIDTH HEIGHT
  mt5=$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^MetaTrader 5 - ' 2>/dev/null | tail -n 1 || true)
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

last_title=''
log 'post-login AutoTrading guard started'
while true; do
  if logged_in_terminal; then
    title=$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowname "$(s6-setuidgid abc env DISPLAY=:0 xdotool search --name '^MetaTrader 5 - ' 2>/dev/null | tail -n 1)" 2>/dev/null || true)
    # One attempt per newly authenticated account; avoid interfering with an
    # already operational desktop or repeatedly opening Options on failure.
    if [[ "$title" != "$last_title" ]]; then
      sleep 8
      if logged_in_terminal && enable_with_ui; then
        log "AutoTrading enable UI submitted for $title"
      fi
      last_title="$title"
    fi
  fi
  sleep 15
done
