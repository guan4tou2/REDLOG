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

# The line the operator typed, not the first simple command of it.
#
# The DEBUG trap fires once per SIMPLE command, so `nmap -sV host && loot.sh`
# arrives as two separate `$BASH_COMMAND` values and the guard below keeps
# only the first. The record then said the operator ran `nmap -sV host` -- the
# `&& loot.sh` half, which may be the step that actually had an effect, was
# absent from the evidence, and the `command_end` row carried the FIRST
# command's text with the WHOLE line's exit code. zsh never had this: its
# `preexec` is handed the full line.
#
# Bash appends the line to history before running it, so `history 1` is that
# line. Two ways it can lie, both handled by falling back to $BASH_COMMAND:
# history may be off, and a line starting with a space is omitted under
# `HISTCONTROL=ignorespace` (which is how RedLog sources this adapter), in
# which case `history 1` returns the PREVIOUS line. The sanity check is that
# the line must contain the simple command we were actually handed.
_redlog_current_line() {
  local line
  line=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null) || return 1
  # Drop the leading whitespace and the history number.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#*[0-9] }"
  # `history` pads the number, so trim again: a leading space in a recorded
  # command is noise in the evidence, and would also make the line look like
  # one deliberately hidden from history.
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -n "$line" ]] || return 1
  # `$BASH_COMMAND` is one simple command of this line; if history is showing
  # us something else, it is not the line we are running.
  [[ "$line" == *"${BASH_COMMAND%% *}"* ]] || return 1
  printf '%s' "$line"
}

_redlog_debug_trap() {
  [[ -z "${_REDLOG_TRAP_ARMED:-}" ]] && return
  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  [[ -n "$_REDLOG_LAST_CMD" ]] && return
  local cmd
  cmd=$(_redlog_current_line) || cmd="$BASH_COMMAND"
  _REDLOG_LAST_CMD="$cmd"
  _REDLOG_CMD_START=$SECONDS
  _redlog_send_event "command_start" "$cmd" \
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
