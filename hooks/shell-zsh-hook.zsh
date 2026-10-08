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
  # Both: the argv for the program lookup, and the raw line for the shapes the
  # relay has to decline — a pipeline with a pager in it, a redirection the
  # operator has already made (FR-029).
  python3 "$_REDLOG_RELAY" classify --home "$(_redlog_home)" \
    --command-line "$1" -- "${words[@]}" 2>/dev/null
}

# --- This terminal's own state (spec 052 US2) ---
#
# One id per shell, minted once, naming the file this terminal and RedLog both
# read. `redlog stop` writes it and the next `preexec` reads it — which is the
# whole of FR-022: a stop held in a shell variable survives neither a subshell
# nor a prompt, and an operator who types `redlog stop` before a client's
# credential and sees it recorded anyway uninstalls the tool.
_REDLOG_SESSION_ID=$(_redlog_new_command_id)
_REDLOG_STATE_FILE=""

_redlog_state_file() {
  if [[ -z "$_REDLOG_STATE_FILE" ]]; then
    local home="${_REDLOG_DIR:-$HOME/.redlog}"
    _REDLOG_STATE_FILE="$home/terminals/${_REDLOG_SESSION_ID}.json"
  fi
  printf '%s' "$_REDLOG_STATE_FILE"
}

# `_REDLOG_DIR` is the `.redlog` directory itself — under WSL it resolves to
# the one in the Windows profile, which is the one RedLog reads. Its parent is
# the home the relay wants.
_redlog_home() {
  if [[ -n "${_REDLOG_DIR:-}" ]]; then printf '%s' "${_REDLOG_DIR:h}"
  else printf '%s' "$HOME"
  fi
}

_redlog_state() {
  python3 "$_REDLOG_RELAY" state --home "$(_redlog_home)" \
    --session "$_REDLOG_SESSION_ID" "$@" 2>/dev/null
}

# Read at every prompt, by the shell itself. A `python3` per command to answer
# a yes/no that is one line of JSON would be paid on the operator's prompt
# forever; `grep` on the same file is the same answer from the same place,
# which is what rule 2 of contracts/shell-commands.md asks for — not a shell
# variable. No file yet means a terminal that has not been told otherwise,
# and the installed default is auto (research.md D4).
_redlog_is_recording() {
  local file
  file=$(_redlog_state_file)
  [[ -f "$file" ]] || return 0
  grep -q '"recording"[[:space:]]*:[[:space:]]*true' "$file"
}

redlog() {
  local sub="${1:-status}"
  shift 2>/dev/null
  case "$sub" in
    status)
      _redlog_state --action show --format human
      print
      ;;
    stop)
      _redlog_state --action stop --reason operator >/dev/null
      # FR-012. "No events for twenty minutes" reads very differently as "the
      # operator stopped recording" than as "the operator was reading", and a
      # reader a year later cannot tell them apart from silence. These two
      # rows bracket the gap the way RedLog's own pause rows already bracket a
      # global one — a pair of its own, because reusing `system.recording_*`
      # would draw a paused band across an engagement that never stopped.
      _redlog_send_event "capture_stopped" "redlog stop" \
        "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"operator\",\"source\":\"auto-relay\"}"
      print -- "[redlog] recording stopped in this terminal — redlog start to resume"
      ;;
    start)
      _redlog_state --action start >/dev/null
      _redlog_send_event "capture_resumed" "redlog start" \
        "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"source\":\"auto-relay\"}"
      print -- "[redlog] recording in this terminal"
      ;;
    mode)
      case "${1:-}" in
        auto|manual)
          _redlog_state --action mode --mode "$1" >/dev/null
          print -- "[redlog] mode $1"
          ;;
        *)
          print -u2 -- 'usage: redlog mode auto|manual'
          return 2
          ;;
      esac
      ;;
    class)
      case "${1:-list}" in
        list)
          python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" --action list
          print
          ;;
        add)
          if [[ -z "${2:-}" || -z "${3:-}" ]]; then
            print -u2 -- 'usage: redlog class add relayed|pty|native <command>'
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" \
            --action add --field "$2" --command "$3" >/dev/null || {
            print -u2 -- "[redlog] no such class: $2"; return 2
          }
          print -- "[redlog] $3 is now $2"
          # FR-028. The cost is not obvious and it is paid in the middle of an
          # engagement, on the command the operator cares most about.
          [[ "$2" == "pty" ]] && print -- \
            "[redlog] note: a pty-captured command cannot be suspended locally — Ctrl-Z will not return you to this shell"
          ;;
        remove)
          if [[ -z "${2:-}" ]]; then
            print -u2 -- 'usage: redlog class remove <command>'
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" \
            --action remove --command "$2" >/dev/null
          print -- "[redlog] $2 is back to the default"
          ;;
        *)
          print -u2 -- 'usage: redlog class list|add relayed|pty|native <command>|remove <command>'
          return 2
          ;;
      esac
      ;;
    *)
      # Rule 3: an unknown subcommand prints the list and exits non-zero, so a
      # typo is not silently a no-op.
      print -u2 -- 'usage: redlog status|start|stop|mode auto|manual|class list|add|remove <command>'
      return 2
      ;;
  esac
}

# FR-010. The dangerous outcome is not a missing command — it is a command from
# engagement A filed under engagement B, which is a lie in a document a client
# reads, written by the tool whose whole job is to be believable.
#
# RedLog rewrites the active identity when the operator opens another project,
# so the terminal finds out by watching that file — named by shell-common, not
# here, because paths into the RedLog directory are transport. `zstat` is a
# builtin: the common case, where nothing changed, costs a stat and no
# process. Only a changed mtime pays for the relay call that compares the
# pinned engagement with the current one.
zmodload -F zsh/stat b:zstat 2>/dev/null

_redlog_check_project() {
  local file
  file=$(_redlog_identity_file)
  [[ -f "$file" ]] || return
  local -a st
  zstat -A st +mtime "$file" 2>/dev/null || return
  [[ "${st[1]}" == "${_REDLOG_IDENTITY_MTIME:-}" ]] && return
  # The first sight of the file is the pin itself, not a switch.
  if [[ -z "${_REDLOG_IDENTITY_MTIME:-}" ]]; then
    _REDLOG_IDENTITY_MTIME="${st[1]}"
    return
  fi
  _REDLOG_IDENTITY_MTIME="${st[1]}"

  local after
  after=$(_redlog_state --action project)
  [[ "$after" == *project-switched* ]] || return
  [[ -n "${_REDLOG_ANNOUNCED_SWITCH:-}" ]] && return
  _REDLOG_ANNOUNCED_SWITCH=1

  # The pin is never updated, so the state still names the project whose work
  # just stopped. The row lands in whichever project RedLog has open now —
  # that is where someone wondering why this terminal went quiet will be
  # looking — and it names the old one explicitly rather than letting the
  # attribution speak for it.
  local pinned=""
  [[ "$after" =~ '"engagementId":[[:space:]]*"([^"]*)"' ]] && pinned="$match[1]"
  _redlog_send_event "session_end" "" \
    "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"project-switched\",\"engagement_id\":\"$pinned\",\"source\":\"auto-relay\"}"
  print -u2 -- "[redlog] the project changed — this terminal stopped recording; open a new terminal for the new project"
}

_redlog_preexec() {
  _redlog_check_project
  _REDLOG_LAST_CMD=""
  _REDLOG_CMD_START=""
  _REDLOG_CMD_ID=""
  _REDLOG_CMD_CLASS=""
  _REDLOG_RELAY_DIR=""

  # The operator said stop. Nothing below runs: no command_start, no relay, no
  # command_end — not a row marked "not captured", because they did not ask for
  # a record of what they were doing with the recording off. The stop itself is
  # in the record and accounts for the gap (FR-012, FR-022).
  #
  # `redlog` is the exception: an operator who has stopped recording must still
  # be able to see that they have, and to start again.
  if [[ "$1" != redlog(| *) ]] && ! _redlog_is_recording; then
    return
  fi

  _REDLOG_LAST_CMD="$1"
  _REDLOG_CMD_START=$EPOCHSECONDS
  _REDLOG_CMD_ID=$(_redlog_new_command_id)

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

# FR-009. The commands run either way — that part has always worked, silently,
# and silence is the bug. An operator whose RedLog crashed two hours ago has
# been working unrecorded with no way to know.
#
# Once, though, and only on the way in. A warning on every prompt is one an
# operator learns to read past, and then the one that matters is read past too.
# The flag is a shell variable on purpose: "have I said this in this shell" is
# not state that should survive a subshell, unlike the stop (FR-022).
_redlog_warn_unreachable() {
  if _redlog_is_running; then
    _REDLOG_WARNED_UNREACHABLE=""
    return
  fi
  [[ -n "${_REDLOG_WARNED_UNREACHABLE:-}" ]] && return
  _REDLOG_WARNED_UNREACHABLE=1
  print -u2 -- "[redlog] RedLog is not reachable — commands are running unrecorded until it is back"
}

_redlog_precmd() {
  local exit_code=$?
  [[ -n "$_REDLOG_LAST_CMD" ]] || return

  _redlog_warn_unreachable

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
      --command-line "$_REDLOG_LAST_CMD" \
      --captured-by auto-relay --source auto-relay 2>/dev/null)
    rm -rf "$_REDLOG_RELAY_DIR"
    _REDLOG_RELAY_DIR=""
  fi

  if [[ -z "$extra" ]]; then
    # No body — and WHY there is no body is the part a reader needs. A command
    # that owns the terminal was never going to be relayed: recording `vim`
    # would store redraws and none of the file, and relaying `nc` would cost
    # the operator the shell upgrade they are in the middle of (FR-026,
    # FR-025). That is `interactive`, a decision. A relay that could not run
    # is `not-captured`, a failure (contracts/events.md). Collapsing the two
    # would make every deliberate silence look like a broken capture, and
    # every broken capture look deliberate.
    local disposition="not-captured"
    case "$_REDLOG_CMD_CLASS" in
      native|pty) disposition="interactive" ;;
      # The operator pointed stdout somewhere else before the command ran, so
      # no relay was started. Same record as when one ran and saw no bytes
      # (FR-008), without two processes watching an empty descriptor.
      redirected) disposition="redirected" ;;
    esac
    extra="{\"exit_code\":$exit_code,\"duration_sec\":$duration,\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"source\":\"auto-relay\",\"completeness\":\"metadata-only\",\"output_disposition\":\"$disposition\"}"
  fi

  _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" "$extra"
  _REDLOG_LAST_CMD=""
  _REDLOG_CMD_START=""
  _REDLOG_CMD_ID=""
  _REDLOG_CMD_CLASS=""
  return $exit_code
}

# --- The PTY class (spec 052 T024, research.md D7) ---
#
# `ssh`, `socat` and `pwncat-cs` bring their own TTY, so diverting the shell's
# descriptors records nothing useful — the bytes are drawn inside a terminal
# the relay never sees. These get a real PTY recorder instead, and the one
# RedLog already has: `hooks/redlog-session.py`, verified under spec 022, with
# bounded output, identity pinned at session start and pause honoured at
# receipt. `script(1)` would be a second recorder with different semantics and
# no identity pinning.
#
# `preexec` cannot do this: zsh gives it no way to replace the command that is
# about to run. A function per program is the mechanism, which is exactly what
# research.md D3 rejected for the GENERAL case — it misses builtins, pipelines
# and anything invoked by path. For a short, explicit list of programs it is
# the right tool, and the limitation is honest: `sudo ssh` and `/usr/bin/ssh`
# go to the native path and are recorded as `interactive`.
_redlog_install_pty_wrappers() {
  local prog
  for prog in ${(f)"$(python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" --field pty 2>/dev/null)"}; do
    [[ -n "$prog" ]] || continue
    # Only wrap what is actually here. A function named `ssh` on a machine
    # without ssh turns "command not found" into a confusing python error.
    command -v -- "$prog" >/dev/null 2>&1 || continue
    functions[$prog]='
      if _redlog_is_running; then
        python3 "$_REDLOG_SESSION_HELPER" --best-effort -- '"$prog"' "$@"
      else
        command '"$prog"' "$@"
      fi'
  done
}

# Pin this terminal's identity and its starting state before the first prompt.
# `begin` is idempotent — a state file that already exists is left alone, so
# re-sourcing the adapter does not undo a `redlog stop`.
_redlog_state --action begin >/dev/null 2>&1

autoload -Uz add-zsh-hook
add-zsh-hook preexec _redlog_preexec
add-zsh-hook precmd _redlog_precmd
_redlog_install_pty_wrappers
_redlog_announce_shell "commands and their output"
