#!/usr/bin/env bash
# RedLog Event Sender — fire-and-forget from any shell / hook script.
# Works natively on macOS/Linux and inside WSL2 (auto-resolves Windows token path).
#
# Usage:
#   hooks/redlog-send.sh "nmap -sV $TARGET" command_start
#   nmap -sV "$TARGET"
#   hooks/redlog-send.sh "nmap -sV $TARGET" command_end "{\"exit_code\":$?}"

set -u

COMMAND="${1:-}"
SUBTYPE="${2:-command_start}"
EXTRA="${3:-}"

[[ -z "$COMMAND" ]] && exit 0

# --- Locate token / port files ---
_resolve_redlog_dir() {
  # Native (macOS / Linux / WSL with symlink)
  if [[ -f "$HOME/.redlog/api-token" ]]; then
    echo "$HOME/.redlog"
    return
  fi
  # WSL: resolve from Windows %USERPROFILE%
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    local win_profile
    win_profile=$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')
    if [[ -n "$win_profile" ]]; then
      local wsl_path
      wsl_path=$(wslpath "$win_profile" 2>/dev/null)
      if [[ -f "$wsl_path/.redlog/api-token" ]]; then
        echo "$wsl_path/.redlog"
        return
      fi
    fi
  fi
  return 1
}

# Cache the resolved dir for the session
if [[ -z "${_REDLOG_DIR:-}" ]]; then
  _REDLOG_DIR=$(_resolve_redlog_dir) || exit 0
  export _REDLOG_DIR
fi

PORT_FILE="$_REDLOG_DIR/api-port"
TOKEN_FILE="$_REDLOG_DIR/api-token"

[[ -f "$PORT_FILE" ]] || exit 0
[[ -f "$TOKEN_FILE" ]] || exit 0

PORT=$(<"$PORT_FILE")
TOKEN=$(<"$TOKEN_FILE")

# --- Resolve reachable host ---
if [[ -z "${_REDLOG_HOST:-}" ]]; then
  _REDLOG_HOST="127.0.0.1"
  if ! curl -sf --connect-timeout 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    # WSL2 NAT mode: try the Windows host gateway
    if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
      local gw
      gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
      if [[ -n "$gw" ]] && curl -sf --connect-timeout 1 "http://${gw}:${PORT}/api/health" >/dev/null 2>&1; then
        _REDLOG_HOST="$gw"
      fi
    fi
  fi
  export _REDLOG_HOST
fi

# --- Build and send event ---
PAYLOAD=$(python3 -c "
import json, sys, os
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': os.environ.get('SHELL', 'bash').rsplit('/', 1)[-1],
        'pid': os.getppid()
    }
}
if sys.argv[3]:
    d['data'].update(json.loads(sys.argv[3]))
print(json.dumps(d))
" "$SUBTYPE" "$COMMAND" "$EXTRA" 2>/dev/null) || exit 0

curl -sf -X POST "http://${_REDLOG_HOST}:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 &
