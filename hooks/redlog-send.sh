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
    # Under WSL a native directory may be stale. Adopt it only while its own
    # token is accepted (/api/health is public and proves nothing about the
    # token); otherwise resolve the Windows profile below (#326). The reasoning
    # is in _redlog_resolve_dir, shell-common.sh, which this mirrors.
    if [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
      echo "$HOME/.redlog"
      return
    fi
    local native_port="" native_code=""
    [[ -f "$HOME/.redlog/api-port" ]] && native_port=$(<"$HOME/.redlog/api-port")
    case "$native_port" in
      ''|*[!0-9]*) ;;
      *)
        native_code=$(printf 'header = "Authorization: Bearer %s"\n' "$(<"$HOME/.redlog/api-token")" \
          | curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
            -K - "http://127.0.0.1:${native_port}/api/whoami" 2>/dev/null)
        case "$native_code" in
          200|503) echo "$HOME/.redlog"; return ;;
        esac ;;
    esac
  fi
  # WSL: resolve from Windows %USERPROFILE%
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    # appendWindowsPath=false leaves cmd.exe off PATH (see shell-common.sh).
    local win_profile win_cmd
    win_cmd=$(command -v cmd.exe) || win_cmd=$(wslpath -u 'C:\Windows\System32\cmd.exe' 2>/dev/null)
    # </dev/null: interop would hand the caller's stdin to cmd.exe (see shell-common.sh).
    win_profile=$("${win_cmd:-cmd.exe}" /c 'echo %USERPROFILE%' </dev/null 2>/dev/null | tr -d '\r')
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
  if ! curl --noproxy '*' -sf --connect-timeout 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    # WSL2 NAT mode: try the Windows host gateway
    if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
      gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
      if [[ -n "$gw" ]] && curl --noproxy '*' -sf --connect-timeout 1 "http://${gw}:${PORT}/api/health" >/dev/null 2>&1; then
        _REDLOG_HOST="$gw"
      fi
    fi
  fi
  export _REDLOG_HOST
fi

# A standalone bash script cannot infer its caller from its own runtime or
# the login $SHELL; use the adapter's declared identity, or unknown (#325).
REPORTED_SHELL="${REDLOG_SHELL:-unknown}"
REPORTED_SHELL="${REPORTED_SHELL##*/}"

# --- Build and send event ---
PAYLOAD=$(python3 -c "
import json, sys, os
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': sys.argv[4],
        'pid': os.getppid()
    }
}
if sys.argv[3]:
    d['data'].update(json.loads(sys.argv[3]))
print(json.dumps(d))
" "$SUBTYPE" "$COMMAND" "$EXTRA" "$REPORTED_SHELL" 2>/dev/null) || exit 0

curl --noproxy '*' -sf -X POST "http://${_REDLOG_HOST}:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 &
