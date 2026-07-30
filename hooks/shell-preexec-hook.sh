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

_REDLOG_LAST_CMD=""
_REDLOG_CMD_START=""

# --- Resolve RedLog dir (token + port files) ---
# Native: $HOME/.redlog; WSL: auto-resolve from Windows %USERPROFILE%
_redlog_resolve_dir() {
  if [[ -f "$HOME/.redlog/api-token" ]]; then
    echo "$HOME/.redlog"
    return
  fi
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

# --- Resolve reachable host ---
_redlog_resolve_host() {
  local port="$1"
  if curl -sf --connect-timeout 1 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "127.0.0.1"
    return
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    local gw
    gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
    if [[ -n "$gw" ]] && curl -sf --connect-timeout 1 "http://${gw}:${port}/api/health" >/dev/null 2>&1; then
      echo "$gw"
      return
    fi
  fi
  echo "127.0.0.1"
}

_redlog_is_running() {
  [[ -n "${_REDLOG_DIR:-}" ]] || { _REDLOG_DIR=$(_redlog_resolve_dir) || return 1; export _REDLOG_DIR; }
  [[ -f "$_REDLOG_DIR/api-port" ]] && [[ -f "$_REDLOG_DIR/api-token" ]]
}

_redlog_send_event() {
  local subtype="$1" command="$2" extra="${3:-}"
  _redlog_is_running || return 0

  local port=$(<"$_REDLOG_DIR/api-port")
  local token=$(<"$_REDLOG_DIR/api-token")

  if [[ -z "${_REDLOG_HOST:-}" ]]; then
    _REDLOG_HOST=$(_redlog_resolve_host "$port")
    export _REDLOG_HOST
  fi

  local payload
  payload=$(python3 -c "
import json, sys, os
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': '${SHELL##*/}',
        'pid': $$
    }
}
if os.environ.get('REDLOG_TERMINAL') == '1':
    d['data']['source'] = 'builtin-terminal'
tid = os.environ.get('REDLOG_TERMINAL_ID')
if tid:
    d['data']['terminalId'] = tid
if sys.argv[3]:
    d['data'].update(json.loads(sys.argv[3]))
print(json.dumps(d))
" "$subtype" "$command" "$extra" 2>/dev/null) || return 0

  curl -sf -X POST "http://${_REDLOG_HOST}:${port}/api/events" \
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
        "{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0},\"cwd\":\"${PWD//\"/\\\"}\"}"
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
        "{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0},\"cwd\":\"${PWD//\"/\\\"}\"}"
      _REDLOG_LAST_CMD=""
      _REDLOG_CMD_START=""
    fi
  }

  trap '_redlog_debug_trap' DEBUG
  PROMPT_COMMAND="_redlog_prompt_command;${PROMPT_COMMAND:-}"
fi

if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  echo "[redlog] shell hook active (WSL: ${WSL_DISTRO_NAME}) — commands will be logged to RedLog timeline"
else
  echo "[redlog] shell hook active — commands will be logged to RedLog timeline"
fi
