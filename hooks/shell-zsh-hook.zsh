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

# Explicit PTY capture owns this child shell; avoid unpinned duplicate events.
[[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0

# --- Automatic output capture (spec 052, research.md D1) ---
#
# For a `relayed` command the shell's OWN stdout and stderr are diverted
# through `hooks/redlog-relay.py` for the duration of the command, and put
# back at the next prompt. The command is not launched inside a subshell or a
# PTY: it keeps the terminal, its stdin and its job control, which is what
# lets `nc` be suspended and `vim` be used (FR-006, measured in O1 — `stty -g`
# is byte-identical across the diversion).
#
# Everything structural is decided out of band. The command id is minted here,
# the class is decided from the argv before the command runs, and nothing in
# the bytes is ever read to decide where a record begins or ends (FR-002).

# zsh splits the line the way zsh will run it — quotes respected — so the
# classifier sees the same argv the shell does. `sudo -u root nc` must reach
# the classifier as four words, not as a string to guess at.
_redlog_class_of() {
  local -a words
  words=(${(z)1})
  python3 "$_REDLOG_RELAY" classify -- "${words[@]}" 2>/dev/null
}

_redlog_preexec() {
  _REDLOG_LAST_CMD="$1"
  _REDLOG_CMD_START=$EPOCHSECONDS
  _REDLOG_CMD_ID=$(_redlog_new_command_id)
  _REDLOG_CMD_CLASS=""
  _REDLOG_RELAY_DIR=""

  if _redlog_is_running && [[ "${REDLOG_EXTERNAL_SESSION:-}" != "1" ]]; then
    _REDLOG_CMD_CLASS=$(_redlog_class_of "$1")
  fi
  : ${_REDLOG_CMD_CLASS:=native}

  if [[ "$_REDLOG_CMD_CLASS" == "relayed" ]]; then
    # A failure anywhere here leaves the descriptors untouched and the command
    # runs unrecorded. Unrecorded is bad; a wedged prompt is worse (FR-009).
    if _REDLOG_RELAY_DIR=$(mktemp -d -t redlog-relay.XXXXXX 2>/dev/null); then
      exec {_REDLOG_SAVED_OUT}>&1 {_REDLOG_SAVED_ERR}>&2
      exec > >(python3 "$_REDLOG_RELAY" pipe --stream stdout \
                 --max-bytes "$_REDLOG_MAX_BYTES" \
                 --event-out "$_REDLOG_RELAY_DIR/stdout.json" >&$_REDLOG_SAVED_OUT) \
          2> >(python3 "$_REDLOG_RELAY" pipe --stream stderr \
                 --max-bytes "$_REDLOG_MAX_BYTES" \
                 --event-out "$_REDLOG_RELAY_DIR/stderr.json" >&$_REDLOG_SAVED_ERR)
    else
      _REDLOG_RELAY_DIR=""
      _REDLOG_CMD_CLASS="native"
    fi
  fi

  _redlog_send_event "command_start" "$1" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"class\":\"$_REDLOG_CMD_CLASS\",\"source\":\"auto-relay\"}"
}

_redlog_precmd() {
  local exit_code=$?
  [[ -n "$_REDLOG_LAST_CMD" ]] || return

  local duration=0
  [[ -n "$_REDLOG_CMD_START" ]] && duration=$(( EPOCHSECONDS - _REDLOG_CMD_START ))

  local extra=""
  if [[ -n "$_REDLOG_RELAY_DIR" ]]; then
    # Putting the descriptors back is what gives the two relays their EOF.
    exec 1>&$_REDLOG_SAVED_OUT 2>&$_REDLOG_SAVED_ERR
    exec {_REDLOG_SAVED_OUT}>&- {_REDLOG_SAVED_ERR}>&-
    # O2: the body is read only after the component that owns the bytes has
    # finished draining. `finish` waits for both part files — each written
    # whole and renamed into place — rather than this function racing them.
    extra=$(python3 "$_REDLOG_RELAY" finish \
      --stdout-part "$_REDLOG_RELAY_DIR/stdout.json" \
      --stderr-part "$_REDLOG_RELAY_DIR/stderr.json" \
      --exit-code "$exit_code" --duration-sec "$duration" \
      --cwd "$PWD" --command-id "$_REDLOG_CMD_ID" \
      --captured-by auto-relay --source auto-relay 2>/dev/null)
    rm -rf "$_REDLOG_RELAY_DIR"
    _REDLOG_RELAY_DIR=""
  fi

  if [[ -z "$extra" ]]; then
    # Either nothing was relayed, or the merge failed. Either way the row
    # lands with the right status and says plainly that no body was held.
    extra="{\"exit_code\":$exit_code,\"duration_sec\":$duration,\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"source\":\"auto-relay\",\"completeness\":\"metadata-only\",\"output_disposition\":\"not-captured\"}"
  fi

  _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" "$extra"
  _REDLOG_LAST_CMD=""
  _REDLOG_CMD_START=""
  _REDLOG_CMD_ID=""
  _REDLOG_CMD_CLASS=""
  return $exit_code
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _redlog_preexec
add-zsh-hook precmd _redlog_precmd
_redlog_announce_shell
