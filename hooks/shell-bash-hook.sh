#!/usr/bin/env bash
# RedLog Bash adapter — lifecycle only. Transport and redlog-run live in
# shell-common.sh so every POSIX adapter emits the same event contract.

if [[ -z "${BASH_VERSION:-}" ]]; then
  printf 'redlog: shell-bash-hook.sh must be sourced by bash\n' >&2
  return 1 2>/dev/null || exit 1
fi

_redlog_adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shell-common.sh
source "$_redlog_adapter_dir/shell-common.sh"
unset _redlog_adapter_dir

# Explicit PTY capture owns this child shell; avoid unpinned duplicate events.
[[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0

_redlog_debug_trap() {
  [[ -z "${_REDLOG_TRAP_ARMED:-}" ]] && return
  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  [[ -n "$_REDLOG_LAST_CMD" ]] && return
  _REDLOG_LAST_CMD="$BASH_COMMAND"
  _REDLOG_CMD_START=$SECONDS
  _redlog_send_event "command_start" "$BASH_COMMAND" \
    "{\"cwd\":\"${PWD//\"/\\\"}\"}"
}

_redlog_prompt_command() {
  local exit_code=$?
  if [[ -z "${_REDLOG_TRAP_ARMED:-}" ]]; then
    _REDLOG_TRAP_ARMED=1
  fi
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
_redlog_announce_shell
