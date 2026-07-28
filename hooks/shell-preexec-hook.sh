#!/usr/bin/env bash
# RedLog Shell Preexec Hook
# Captures every command executed in the terminal and sends to RedLog.
# Works with ANY agent that spawns a shell (Claude Code, Codex, GPT, Cursor, etc.)
#
# Usage — add to your ~/.zshrc or ~/.bashrc:
#   source /path/to/redlog/hooks/shell-preexec-hook.sh
#
# This hooks into:
#   - zsh:  preexec / precmd
#   - bash: DEBUG trap + PROMPT_COMMAND

_REDLOG_PORT_FILE="$HOME/.redlog/api-port"
_REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"
_REDLOG_LAST_CMD=""
_REDLOG_CMD_START=""

_redlog_is_running() {
  [[ -f "$_REDLOG_PORT_FILE" ]] && [[ -f "$_REDLOG_TOKEN_FILE" ]]
}

_redlog_send_event() {
  local subtype="$1" command="$2" extra="${3:-}"
  _redlog_is_running || return 0

  local port=$(<"$_REDLOG_PORT_FILE")
  local token=$(<"$_REDLOG_TOKEN_FILE")

  local payload
  payload=$(python3 -c "
import json, sys
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': '${SHELL##*/}',
        'pid': $$$
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
    --connect-timeout 1 --max-time 2 >/dev/null 2>&1 &
}

# --- Zsh hooks ---
if [[ -n "${ZSH_VERSION:-}" ]]; then
  _redlog_preexec() {
    _REDLOG_LAST_CMD="$1"
    _REDLOG_CMD_START=$EPOCHSECONDS
    _redlog_send_event "command_start" "$1"
  }

  _redlog_precmd() {
    local exit_code=$?
    if [[ -n "$_REDLOG_LAST_CMD" ]]; then
      local duration=""
      if [[ -n "$_REDLOG_CMD_START" ]]; then
        duration=$(( EPOCHSECONDS - _REDLOG_CMD_START ))
      fi
      _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" \
        "{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0}}"
      _REDLOG_LAST_CMD=""
      _REDLOG_CMD_START=""
    fi
  }

  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _redlog_preexec
  add-zsh-hook precmd _redlog_precmd

# --- Bash hooks ---
elif [[ -n "${BASH_VERSION:-}" ]]; then
  _redlog_debug_trap() {
    if [[ "$BASH_COMMAND" != "$PROMPT_COMMAND" ]] && [[ -z "$_REDLOG_LAST_CMD" ]]; then
      _REDLOG_LAST_CMD="$BASH_COMMAND"
      _REDLOG_CMD_START=$SECONDS
      _redlog_send_event "command_start" "$BASH_COMMAND"
    fi
  }

  _redlog_prompt_command() {
    local exit_code=$?
    if [[ -n "$_REDLOG_LAST_CMD" ]]; then
      local duration=""
      if [[ -n "$_REDLOG_CMD_START" ]]; then
        duration=$(( SECONDS - _REDLOG_CMD_START ))
      fi
      _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" \
        "{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0}}"
      _REDLOG_LAST_CMD=""
      _REDLOG_CMD_START=""
    fi
  }

  trap '_redlog_debug_trap' DEBUG
  PROMPT_COMMAND="_redlog_prompt_command;${PROMPT_COMMAND:-}"
fi

echo "[redlog] shell hook active — commands will be logged to RedLog timeline"
