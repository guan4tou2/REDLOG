#!/usr/bin/env zsh
# RedLog Zsh adapter — lifecycle only. Transport and redlog-run live in
# shell-common.sh so every POSIX adapter emits the same event contract.

if [[ -z "${ZSH_VERSION:-}" ]]; then
  print -u2 'redlog: shell-zsh-hook.zsh must be sourced by zsh'
  return 1 2>/dev/null || exit 1
fi

_redlog_adapter_dir="${${(%):-%N}:A:h}"
# shellcheck source=shell-common.sh
source "$_redlog_adapter_dir/shell-common.sh"
unset _redlog_adapter_dir

_redlog_preexec() {
  _REDLOG_LAST_CMD="$1"
  _REDLOG_CMD_START=$EPOCHSECONDS
  _redlog_send_event "command_start" "$1" \
    "{\"cwd\":\"${PWD//\"/\\\"}\"}"
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
_redlog_announce_shell
