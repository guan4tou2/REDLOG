#!/usr/bin/env bash
# RedLog Bash adapter — lifecycle only. Transport and redlog-run live in
# shell-common.sh so every POSIX adapter emits the same event contract.

if [[ -z "${BASH_VERSION:-}" ]]; then
  printf 'redlog: shell-bash-hook.sh must be sourced by bash\n' >&2
  return 1 2>/dev/null || exit 1
fi

_redlog_adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Local identity describes this interpreter; the exported value lets a
# standalone sender identify its caller without guessing from $SHELL (#325).
_REDLOG_ADAPTER_SHELL=bash
export REDLOG_SHELL=bash
# shellcheck source=shell-common.sh
source "$_redlog_adapter_dir/shell-common.sh"
unset _redlog_adapter_dir

# Explicit PTY capture owns this child shell; avoid unpinned duplicate events.
[[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0

# Same provenance rule as the zsh adapter: the embedded pane owns the identity
# even when this adapter relays the output.
_REDLOG_EVENT_SOURCE=auto-relay
[[ "${REDLOG_TERMINAL:-}" == "1" ]] && _REDLOG_EVENT_SOURCE=builtin-terminal

# --- Automatic output capture ---
#
# What the zsh adapter does in `preexec`, done here in the DEBUG trap, which is
# bash's closest thing: it runs before the command, in the shell itself, so a
# redirection made with `exec` there is the shell's own. The command's stdout
# and stderr are pointed at two ptys that `redlog-relay.py` reads and passes
# through to the real terminal; `_redlog_prompt_command` points them back,
# which is what gives the relay its EOF, and then asks the relay for the body.
# stdin is never touched, so job control and `nc` keep the real terminal.
#
# Differences from zsh that matter:
#   - bash 3.2 (what macOS ships) has no `exec {fd}>&1`, so the saved
#     descriptors are fixed numbers, 8 and 9. If either is already open the
#     command runs unrecorded rather than have the operator's own fd closed.
#   - the relay is a background job that is disowned at once, so bash prints no
#     `[1] 1234` notice and the operator's `jobs` never lists it.
#   - a failure anywhere leaves the descriptors as they were. Unrecorded is
#     bad; a wedged prompt is worse (FR-009).
_REDLOG_RELAY_DIR=""
_REDLOG_CMD_ID=""
_REDLOG_CMD_CLASS=""

_redlog_pagers_off() {
  local name
  for name in PAGER GIT_PAGER MANPAGER SYSTEMD_PAGER; do
    if [[ -n "${!name+set}" ]]; then
      printf -v "_REDLOG_PAGER_WAS_$name" '%s' set
      printf -v "_REDLOG_PAGER_VAL_$name" '%s' "${!name}"
    else
      printf -v "_REDLOG_PAGER_WAS_$name" '%s' ''
    fi
    export "$name=cat"
  done
}

_redlog_pagers_restore() {
  local name was val
  for name in PAGER GIT_PAGER MANPAGER SYSTEMD_PAGER; do
    was="_REDLOG_PAGER_WAS_$name"; val="_REDLOG_PAGER_VAL_$name"
    if [[ -n "${!was:-}" ]]; then export "$name=${!val}"; else unset "$name"; fi
  done
}

_redlog_divert() {
  local dir=$1 pts_out="" pts_err="" ready
  [[ -e /dev/fd/7 || -e /dev/fd/8 || -e /dev/fd/9 ]] && return 1
  # Woken by the relay rather than polling: a `sleep 0.01` loop here is a
  # foreground process, and a Ctrl-C typed in its first fifty milliseconds
  # killed the sleep instead of the command and left `$?` at 1, not 130.
  [[ "$(mkfifo "$dir/ready" 2>&1 && echo ok)" == ok ]] || return 1
  exec 7<>"$dir/ready" || return 1
  exec 8>&1 9>&2 || { exec 7>&-; return 1; }
  # A background job of this shell, but not on its job list: the start notice
  # goes to the 2>/dev/null of the group, and `disown` takes it off the list so
  # `jobs` never shows it and no "Done" line is printed at a later prompt. A
  # subshell around it was tried first and left a "Done" entry per command,
  # which also pushed the operator's own job numbers up by one each time.
  local relay_pid
  { python3 "$_REDLOG_RELAY" pty --dir "$dir" --err-fd 3 --notify "$dir/ready" \
      --max-bytes "$_REDLOG_MAX_BYTES" >&8 3>&9 8>&- 9>&- </dev/null &
    relay_pid=$!; } 2>/dev/null
  disown "$relay_pid" 2>/dev/null
  echo "$relay_pid" >"$dir/pid"
  [[ -s "$dir/pts" ]] || read -r -t 5 -u 7 ready
  exec 7>&-
  [[ -s "$dir/pts" ]] && { IFS= read -r pts_out; IFS= read -r pts_err; } <"$dir/pts"
  if [[ -n "$pts_out" && -n "$pts_err" ]] && exec 1>|"$pts_out" 2>|"$pts_err"; then
    : >"$dir/opened"
    _redlog_pagers_off
    return 0
  fi
  exec 1>&8 2>&9
  exec 8>&- 9>&-
  [[ -s "$dir/pid" ]] && kill "$(<"$dir/pid")" 2>/dev/null
  return 1
}

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
  # An empty Enter or a bare function definition runs no simple command, so
  # the first thing traced after it is our own prompt hook.
  [[ "$BASH_COMMAND" == _redlog_prompt_command || "$BASH_COMMAND" == _redlog_arm ]] && return
  [[ -n "$_REDLOG_LAST_CMD" ]] && return
  local cmd whole=1
  cmd=$(_redlog_current_line) || { cmd="$BASH_COMMAND"; whole=0; }
  _REDLOG_LAST_CMD="$cmd"
  _REDLOG_CMD_START=$SECONDS
  _REDLOG_CMD_ID=$(_redlog_new_command_id)
  _REDLOG_CMD_CLASS=native
  _REDLOG_DIVERT_FAILED=""

  # Only a whole line is classified. When history could not give it, all that
  # is known is one simple command of it, and deciding "this is relayed" from
  # the first stage of `a | less` is exactly the mistake FR-029 exists for.
  if (( whole )) && _redlog_is_running; then
    local -a words
    local home=$HOME
    [[ -n "${_REDLOG_DIR:-}" ]] && home=${_REDLOG_DIR%/*}
    read -r -a words <<<"$cmd"
    # Externals are run inside `$( )` throughout this trap. Measured on bash
    # 3.2: a bare external command run from a DEBUG trap takes the next job
    # number and leaves a "Done" line in the operator's `jobs`; the same command
    # in a command substitution does neither.
    _REDLOG_CMD_CLASS=$(python3 "$_REDLOG_RELAY" classify --home "$home" \
      --command-line "$cmd" -- "${words[@]}" 2>/dev/null)
    : "${_REDLOG_CMD_CLASS:=native}"
  fi

  if [[ "$_REDLOG_CMD_CLASS" == "relayed" ]]; then
    _REDLOG_RELAY_DIR="${TMPDIR:-/tmp}/redlog-relay.$$.$RANDOM$RANDOM"
    if [[ "$(mkdir -m 700 "$_REDLOG_RELAY_DIR" 2>&1 && echo ok)" == ok ]] \
       && _redlog_divert "$_REDLOG_RELAY_DIR"; then
      :
    else
      : "$(rm -rf "$_REDLOG_RELAY_DIR" 2>/dev/null)"
      _REDLOG_RELAY_DIR=""
      # Said at the end as `not-captured`: the relay was meant to run and did
      # not, which is a failure, where `native` is a decision.
      _REDLOG_DIVERT_FAILED=1
      _REDLOG_CMD_CLASS=native
    fi
  fi

  _redlog_send_event "command_start" "$cmd" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"class\":\"$_REDLOG_CMD_CLASS\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
}


# The DEBUG trap fires for every simple command, including the ones inside
# PROMPT_COMMAND. Without this pair the operator's own prompt command (history
# -a, a prompt function) was recorded as "the command", and because a command
# was then "in flight" the next real one was dropped: nothing they typed was
# recorded. Disarm first, re-arm last; the trap only counts while armed.
_redlog_arm() { _REDLOG_TRAP_ARMED=1; }

_redlog_prompt_command() {
  local exit_code=$?
  _REDLOG_TRAP_ARMED=
  local extra=""
  if [[ -n "$_REDLOG_RELAY_DIR" ]]; then
    # First thing, before anything can print: putting the descriptors back is
    # what gives the two relays their EOF.
    exec 1>&8 2>&9
    exec 8>&- 9>&-
    : >"$_REDLOG_RELAY_DIR/closed"
    _redlog_pagers_restore
    local dur=$(( SECONDS - ${_REDLOG_CMD_START:-$SECONDS} ))
    extra=$(python3 "$_REDLOG_RELAY" finish \
      --stdout-part "$_REDLOG_RELAY_DIR/stdout.json" \
      --stderr-part "$_REDLOG_RELAY_DIR/stderr.json" \
      --exit-code "$exit_code" --duration-sec "$dur" \
      --cwd "$PWD" --command-id "$_REDLOG_CMD_ID" \
      --command-line "$_REDLOG_LAST_CMD" \
      --captured-by auto-relay --source "$_REDLOG_EVENT_SOURCE" 2>/dev/null)
    : "$(rm -rf "$_REDLOG_RELAY_DIR" 2>/dev/null)"
    _REDLOG_RELAY_DIR=""
  fi
  if [[ -n "$_REDLOG_LAST_CMD" ]]; then
    local duration=""
    if [[ -n "$_REDLOG_CMD_START" ]]; then
      duration=$(( SECONDS - _REDLOG_CMD_START ))
    fi
    if [[ -z "$extra" ]]; then
      # No body, and why is the part a reader needs: a command that owns the
      # terminal was never going to be relayed (a decision); a relay that could
      # not run is a failure. Same two words as the zsh adapter.
      local disposition="not-captured"
      case "$_REDLOG_CMD_CLASS" in
        native|pty) [[ -n "$_REDLOG_DIVERT_FAILED" ]] || disposition="interactive" ;;
        redirected) disposition="redirected" ;;
      esac
      extra="{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0},\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"source\":\"$_REDLOG_EVENT_SOURCE\",\"completeness\":\"metadata-only\",\"output_disposition\":\"$disposition\"}"
    fi
    _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" "$extra"
    _REDLOG_LAST_CMD=""
    _REDLOG_CMD_START=""
    _REDLOG_CMD_ID=""
    _REDLOG_CMD_CLASS=""
  fi
  return $exit_code
}

trap '_redlog_debug_trap' DEBUG
_redlog_user_pc="${PROMPT_COMMAND:-}"
# A trailing `;` or blank in the operator's value would make `;;` a syntax error.
_redlog_user_pc="${_redlog_user_pc%"${_redlog_user_pc##*[![:space:];]}"}"
if [[ -n "$_redlog_user_pc" ]]; then
  PROMPT_COMMAND="_redlog_prompt_command;${_redlog_user_pc};_redlog_arm"
else
  PROMPT_COMMAND="_redlog_prompt_command;_redlog_arm"
fi
unset _redlog_user_pc
_redlog_announce_shell "commands and their output"
