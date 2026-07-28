#!/usr/bin/env bash
# RedLog × Codex/GPT Wrapper
# Wraps a shell session so ALL commands from any AI agent are captured.
# Use this when you can't modify the agent's hook system directly.
#
# Usage:
#   # Start a wrapped shell for the agent to use:
#   ./hooks/codex-wrapper.sh
#
#   # Or wrap a specific command:
#   ./hooks/codex-wrapper.sh nmap -sV target.com
#
#   # For Codex CLI, set SHELL to this wrapper:
#   SHELL=/path/to/redlog/hooks/codex-wrapper.sh codex run "scan the target"

set -uo pipefail

REDLOG_PORT_FILE="$HOME/.redlog/api-port"
REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"

_send_to_redlog() {
  local subtype="$1" command="$2" extra="${3:-}"
  [[ -f "$REDLOG_PORT_FILE" ]] || return 0
  [[ -f "$REDLOG_TOKEN_FILE" ]] || return 0

  local port=$(<"$REDLOG_PORT_FILE")
  local token=$(<"$REDLOG_TOKEN_FILE")

  local payload
  payload=$(python3 -c "
import json, sys
d = {
    'agent_type': 'agent',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'wrapper': 'codex-wrapper',
        'pid': $$
    }
}
if sys.argv[3]:
    d['data'].update(json.loads(sys.argv[3]))
print(json.dumps(d))
" "$subtype" "$command" "$extra" 2>/dev/null) || return 0

  curl -sf -X POST "http://127.0.0.1:${port}/api/events" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true
}

if [[ $# -gt 0 ]]; then
  CMD="$*"
  _send_to_redlog "command_start" "$CMD"
  START=$SECONDS
  eval "$CMD"
  EXIT_CODE=$?
  DURATION=$(( SECONDS - START ))
  _send_to_redlog "command_end" "$CMD" "{\"exit_code\":$EXIT_CODE,\"duration_sec\":$DURATION}"
  exit $EXIT_CODE
else
  export REDLOG_SHELL_WRAPPED=1
  echo "[redlog] wrapped shell active — all commands logged to RedLog"
  source "$(dirname "$0")/shell-preexec-hook.sh"
  exec "${SHELL:-/bin/zsh}"
fi
