#!/usr/bin/env bash
# Enable AutoTrading only after MT5 reports a logged-in terminal with it off.
set -u

LOG=/var/log/ensure-autotrading.log
log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

main_terminal_window() {
  local window title
  while read -r window; do
    title=$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowname "$window" 2>/dev/null || true)
    [[ "$title" =~ ,(M[0-9]+|H[0-9]+|D[0-9]+|W[0-9]+|MN[0-9]+)$ ]] && { printf '%s' "$window"; return 0; }
  done < <(s6-setuidgid abc env DISPLAY=:0 xdotool search --name . 2>/dev/null || true)
  return 1
}

account_state() {
  printf '{"id":"autotrading","action":"account","payload":{}}\n' | nc -w 3 127.0.0.1 7780 2>/dev/null
}

needs_autotrading() {
  local state
  state=$(account_state) || return 1
  [[ "$state" == *'"ok":true'* && "$state" == *'"terminal_trade_allowed":false'* ]]
}

autotrading_ready() {
  local state
  state=$(account_state) || return 1
  [[ "$state" == *'"ok":true'* && "$state" == *'"terminal_trade_allowed":true'* ]]
}

last_title=''
log 'post-login AutoTrading guard started'
while true; do
  window=$(main_terminal_window || true)
  if [[ -n "$window" ]] && needs_autotrading; then
    title=$(s6-setuidgid abc env DISPLAY=:0 xdotool getwindowname "$window" 2>/dev/null || true)
    if [[ "$title" != "$last_title" ]]; then
      s6-setuidgid abc env DISPLAY=:0 xdotool windowactivate --sync "$window" key Escape key ctrl+e
      sleep 3
      if autotrading_ready; then
        log "AutoTrading enabled for $title"
      else
        log "AutoTrading toggle did not verify for $title"
      fi
      last_title="$title"
    fi
  else
    last_title=''
  fi
  sleep 5
done
