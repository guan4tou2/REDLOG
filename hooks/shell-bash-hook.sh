#!/usr/bin/env bash
# RedLog Bash adapter — lifecycle only. Transport and redlog-run live in
# shell-common.sh so every POSIX adapter emits the same event contract.

if [[ -z "${BASH_VERSION:-}" ]]; then
  printf 'redlog: shell-bash-hook.sh must be sourced by bash\n' >&2
  return 1 2>/dev/null || exit 1
fi

# Sourced twice from one rc (a relative and an absolute path to the same file
# are the usual way) the banner printed twice and the prompt hooks registered
# twice. Plain, un-exported: a child shell is a new interpreter and must load.
[[ "${_REDLOG_HOOK_LOADED_IN:-}" == "$$" ]] && return 0

_redlog_adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Local identity describes this interpreter; the exported value lets a
# standalone sender identify its caller without guessing from $SHELL (#325).
_REDLOG_ADAPTER_SHELL=bash
export REDLOG_SHELL=bash
# shellcheck source=shell-common.sh
source "$_redlog_adapter_dir/shell-common.sh"
unset _redlog_adapter_dir
_redlog_terminal_allowed || return 0
_REDLOG_HOOK_LOADED_IN=$$

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
# Not exported: a child shell reports for itself.
_REDLOG_TOOLS_REPORTED=""
_REDLOG_CMD_ID=""
_REDLOG_CMD_CLASS=""
_REDLOG_CMD_CAPTURE=""

# --- This terminal's own state (spec 052 US2), same contract as zsh ---
#
# One id per shell, naming a file this terminal and RedLog both read. `redlog
# stop` writes it and the next command's trap reads it: a stop held in a shell
# variable survives neither a subshell nor a prompt, and an operator who types
# `redlog stop` before a client's credential and sees it recorded anyway
# uninstalls the tool (FR-022). The transitions live in redlog-relay.py.
_REDLOG_SESSION_ID=${REDLOG_TERMINAL_ID:-$(_redlog_new_command_id)}
export _REDLOG_SESSION_ID
_REDLOG_SKIP=""

_redlog_state_file() {
  printf '%s/terminals/%s.json' "${_REDLOG_DIR:-$HOME/.redlog}" "$_REDLOG_SESSION_ID"
}

_redlog_state() {
  local home=$HOME
  [[ -n "${_REDLOG_DIR:-}" ]] && home=${_REDLOG_DIR%/*}
  python3 "$_REDLOG_RELAY" state --home "$home" \
    --session "$_REDLOG_SESSION_ID" "$@" 2>/dev/null
}

# No file yet means a terminal that has not been told otherwise: recording.
_redlog_is_recording() {
  _redlog_terminal_allowed || return 1
  local file
  file=$(_redlog_state_file)
  [[ -f "$file" ]] || return 0
  grep -q '"recording"[[:space:]]*:[[:space:]]*true' "$file"
}

redlog() {
  local sub="${1:-status}"
  shift 2>/dev/null
  local home=$HOME
  [[ -n "${_REDLOG_DIR:-}" ]] && home=${_REDLOG_DIR%/*}
  case "$sub" in
    status)
      _redlog_state --action show --format human
      echo
      ;;
    stop)
      _redlog_state --action stop --reason operator >/dev/null
      # FR-012: "no events for twenty minutes" must read as a decision, not as
      # silence. This pair brackets the gap; it is not the global pause's pair.
      _redlog_send_event "capture_stopped" "redlog stop" \
        "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"operator\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
      echo "[redlog] recording stopped in this terminal — redlog start to resume"
      ;;
    start)
      _redlog_state --action start >/dev/null
      if _redlog_is_recording; then
        _redlog_send_event "capture_resumed" "redlog start" \
          "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
      fi
      _redlog_state --action show --format human
      echo
      ;;
    mode)
      case "${1:-}" in
        auto|manual)
          _redlog_state --action mode --mode "$1" >/dev/null
          echo "[redlog] mode $1"
          ;;
        *)
          echo 'usage: redlog mode auto|manual' >&2
          return 2
          ;;
      esac
      ;;
    class)
      case "${1:-list}" in
        list)
          python3 "$_REDLOG_RELAY" policy --home "$home" --action list
          echo
          ;;
        add)
          if [[ -z "${2:-}" || -z "${3:-}" ]]; then
            echo 'usage: redlog class add relayed|pty|native <command>' >&2
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$home" \
            --action add --field "$2" --command "$3" >/dev/null
          # 3 is a name the wrapper cannot be built from, 4 an overlay that was
          # not rewritten because it could not be read (the relay said why);
          # anything else is the class.
          case $? in
            0) ;;
            3) echo "[redlog] not a command name: $3 (letters, digits, . _ + - only)" >&2; return 2 ;;
            4) return 2 ;;
            *) echo "[redlog] no such class: $2" >&2; return 2 ;;
          esac
          echo "[redlog] $3 is now $2"
          # zsh wraps the pty class in a recorder; bash does not (yet), and
          # saying otherwise would promise output that is not captured.
          # An `if`, not `&&`: as the last command, a false test would be
          # the function's status and a successful add would return 1.
          if [[ "$2" == "pty" ]]; then
            echo "[redlog] note: bash does not wrap pty-class commands — $3 will be recorded as interactive, without its output"
          fi
          ;;
        remove)
          if [[ -z "${2:-}" ]]; then
            echo 'usage: redlog class remove <command>' >&2
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$home" \
            --action remove --command "$2" >/dev/null
          # The relay has said why when it did not rewrite the overlay.
          case $? in
            0) ;;
            3) echo "[redlog] not a command name: $2 (letters, digits, . _ + - only)" >&2; return 2 ;;
            *) return 2 ;;
          esac
          echo "[redlog] $2 is back to the default"
          ;;
        *)
          echo 'usage: redlog class list|add relayed|pty|native <command>|remove <command>' >&2
          return 2
          ;;
      esac
      ;;
    *)
      echo 'usage: redlog status|start|stop|mode auto|manual|class list|add|remove <command>' >&2
      return 2
      ;;
  esac
}

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
  local home=$HOME
  [[ -n "${_REDLOG_DIR:-}" ]] && home=${_REDLOG_DIR%/*}
  # The command id, source and home let the relay send what a background job
  # prints after the prompt is back, attributed to this command.
  { python3 "$_REDLOG_RELAY" pty --dir "$dir" --err-fd 3 --notify "$dir/ready" \
      --max-bytes "$_REDLOG_MAX_BYTES" --command-id "$_REDLOG_CMD_ID" \
      --source "$_REDLOG_EVENT_SOURCE" --captured-by auto-relay --home "$home" \
      >&8 3>&9 8>&- 9>&- </dev/null &
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

_redlog_trace_command() {
  [[ -z "${_REDLOG_TRAP_ARMED:-}" ]] && return
  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  # An empty Enter or a bare function definition runs no simple command, so
  # the first thing traced after it is our own prompt hook.
  # The rest of the hook's own prompt command, for when something runs it while
  # armed (a hook loaded twice gives a prompt command two tails).
  case "$BASH_COMMAND" in
    _redlog_prompt_command|_redlog_arm*|_redlog_trap_plan*|*_REDLOG_TRAP_NEXT*) return ;;
  esac
  [[ -n "$_REDLOG_LAST_CMD" || -n "$_REDLOG_SKIP" ]] && return
  local cmd whole=1
  cmd=$(_redlog_current_line) || { cmd="$BASH_COMMAND"; whole=0; }

  # The operator said stop. Nothing below runs: no command_start, no relay, no
  # command_end, and not a row marked "not captured" — they did not ask for a
  # record of what they were doing with the recording off. The stop is in the
  # record and accounts for the gap. `redlog` is exempt so an operator who has
  # stopped can still see that they have, and start again. The skip flag keeps
  # the later simple commands of this same line from starting a record.
  if [[ "$BASH_COMMAND" != redlog && "$BASH_COMMAND" != "redlog "* ]] && ! _redlog_is_recording; then
    _REDLOG_SKIP=1
    return
  fi
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

  # `class` is the policy; it is not a claim about how this run was captured.
  # Bash installs no PTY wrapper (zsh does), so a `pty` program runs on the
  # shell's own terminal and is recorded as metadata only. The record says so
  # beside the class, as the zsh adapter does for its `existing-shell-function`
  # case, rather than letting `pty` read as "PTY-captured". `redlog class add
  # pty` already warns the operator of this; the evidence has to carry it too.
  _REDLOG_CMD_CAPTURE=""
  if [[ "$_REDLOG_CMD_CLASS" == "pty" ]]; then
    _REDLOG_CMD_CAPTURE=',"capture_mode":"native","capture_reason":"no-pty-wrapper"'
  fi

  _redlog_send_event "command_start" "$cmd" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"class\":\"$_REDLOG_CMD_CLASS\",\"source\":\"$_REDLOG_EVENT_SOURCE\"$_REDLOG_CMD_CAPTURE}"
}

# What the DEBUG trap runs. Alone when nothing else holds the trap; behind
# another tool's trap, see `_redlog_arm`. `$1` is the status that other trap
# ended with, handed back so that under `extdebug` (where a trap's status says
# whether the command runs) REDLOG neither skips a command the other tool let
# through nor lets one through that it stopped. Without a trap before it the
# status is 0: the previous command's `$?` is not an answer to "may this run".
_redlog_debug_trap() {
  local rc=${1:-0}
  _redlog_trace_command
  return "$rc"
}

# The DEBUG trap fires for every simple command, including the ones inside
# PROMPT_COMMAND. Without this pair the operator's own prompt command (history
# -a, a prompt function) was recorded as "the command", and because a command
# was then "in flight" the next real one was dropped: nothing they typed was
# recorded. Disarm first, re-arm last; the trap only counts while armed.
_redlog_arm() { _REDLOG_TRAP_ARMED=1; }

# Where REDLOG's trap is put in place, and kept there. Bash keeps one DEBUG
# trap per shell, and bash-preexec, starship's bash init and atuin all keep
# their hook in it: a bare `trap '...' DEBUG` took theirs away without a word.
# This decides, and sets `_REDLOG_TRAP_NEXT` to the trap to install, or to
# nothing. `$1` is `trap -p DEBUG`.
#
#   - Nobody holds the trap: install REDLOG's.
#   - Someone else does, and REDLOG is not in it: install theirs followed by
#     REDLOG's, in one trap. Theirs goes first, so it sees `$?`, `$_` and
#     `$BASH_COMMAND` exactly as it would have without us, and what it prints
#     goes to the terminal rather than into the command's recorded output.
#   - REDLOG is already in it (an earlier prompt's, or one a tool chained and
#     kept): leave it. Matching on our own function name is also what stops a
#     hook sourced twice from chaining to itself.
#
# Looking at every prompt is what covers a tool that sets its trap AFTER we load.
# That is routine -- bash-preexec installs from its first PROMPT_COMMAND, after
# the rc that sourced us -- and REDLOG cannot stop it. The prompt command runs
# after the operator's own, so by the time a command is typed the trap is ours
# again, with theirs in front. Two limits, both left as they are: a tool that
# swaps the trap in a typed line costs only the rest of that line, because the
# record falls back to history at the next prompt (`not-captured`: the line and
# its status, none of its output); and a tool that replaces it at every prompt
# is chained to afresh each time rather than stacked, so it cannot grow.
#
# Two things about bash itself decide where this runs and how it reads the trap:
#
#   - The trap has to be both READ and SET at the prompt command's top level,
#     which is why the prompt command carries `$(trap -p DEBUG)` and the `trap`
#     itself rather than a function doing either. A DEBUG trap is invisible
#     inside a function, a sourced file and a `$( )` alike unless `functrace` is
#     on (turning that on would change which commands the trap sees). And on
#     bash before 5.1, as CI's macOS runner showed, a DEBUG trap set INSIDE a
#     function is thrown away when the function returns whenever a DEBUG trap
#     already existed: the other tool's trap stayed and REDLOG's never arrived.
#   - A bash whose `$( )` cannot see the trap even at the top level shows
#     nothing at every prompt, REDLOG's own trap included. Seeing it once is
#     proof that it can (`_REDLOG_TRAP_SEEN`). Until then, an empty answer after
#     REDLOG has installed is not "the operator removed it", and installing
#     again would take the trap back from a tool at every prompt, so it is left:
#     such a bash gets REDLOG's trap installed once, as it always did, and no
#     chaining.
#
# `trap -p` prints `trap -- 'body' DEBUG`, quoted for the shell to read back,
# so `eval set --` is what splits it. `body` can be anything the other tool put
# there; a `return` or a `$1` in it would meet the trap's own frame, and none of
# the tools above do either.
_redlog_trap_plan() {
  local current=$1 body=""
  _REDLOG_TRAP_NEXT=""
  if [[ "$current" == *_redlog_debug_trap* ]]; then
    _REDLOG_TRAP_SEEN=1
    return 0
  fi
  if [[ -n "$current" ]]; then
    eval "set -- $current"
    body=$3
  elif [[ -n "${_REDLOG_TRAP_INSTALLED:-}" && -z "${_REDLOG_TRAP_SEEN:-}" ]]; then
    return 0
  fi
  _REDLOG_TRAP_INSTALLED=1
  if [[ -n "$body" ]]; then
    # A newline, not `;`: the other tool's last line may end in a comment.
    _REDLOG_TRAP_NEXT="$body"$'\n''_redlog_debug_trap $?'
  else
    _REDLOG_TRAP_NEXT='_redlog_debug_trap'
  fi
}


# A line the DEBUG trap never saw: `( cd x; make )`, `{ a; b; }`, a function
# definition. A subshell or group compound runs its simple commands where the
# trap does not follow, so the whole line passes without one `command_start`
# and the record has a hole exactly where the operator did something.
#
# What does show is the history number: typing a line advances it by one
# whether or not the trap fired. (Not `$HISTCMD`: inside PROMPT_COMMAND it reads
# a stale 1 on bash 3.2, measured, while `history 1` carries the real number.)
# So at the prompt, a number that moved by exactly one while nothing was
# started is a line that ran untraced. Exactly
# one, on purpose: `history -c`, `history -r` or a hidden line (ignorespace,
# ignoredups) move it some other way or not at all, and a guess here would
# write a command the operator did not run. Those stay unrecorded. Only the
# line and its exit code are known -- the output went to the terminal -- so the
# row says `not-captured`, which is what happened.
_redlog_history_number() {
  local h
  h=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null) || return 1
  h="${h#"${h%%[![:space:]]*}"}"
  [[ "$h" == [0-9]* ]] || return 1
  printf '%s' "${h%%[!0-9]*}"
}

_redlog_record_untraced_line() {
  local exit_code=$1 line id num=$2
  [[ -n "$num" && -n "${_REDLOG_HISTNUM:-}" ]] || return 0
  (( num == _REDLOG_HISTNUM + 1 )) || return 0
  _redlog_is_recording || return 0
  line=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null) || return 0
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#*[0-9] }"
  line="${line#"${line%%[![:space:]]*}"}"
  # A comment typed at the prompt is in history and ran nothing.
  [[ -n "$line" && "$line" != "#"* ]] || return 0
  # A definition runs nothing either, and is the one untraced line that is
  # not an action: `f() { ...; }` and `function f ...` stay out of the record,
  # as they always have.
  [[ "$line" =~ ^[[:space:]]*(function[[:space:]]+)?[A-Za-z_][A-Za-z0-9_:.-]*[[:space:]]*\(\) ]] && return 0
  [[ "$line" =~ ^[[:space:]]*function[[:space:]] ]] && return 0
  id=$(_redlog_new_command_id)
  _redlog_send_event "command_start" "$line" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$id\",\"class\":\"native\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
  _redlog_send_event "command_end" "$line" \
    "{\"exit_code\":$exit_code,\"duration_sec\":0,\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$id\",\"source\":\"$_REDLOG_EVENT_SOURCE\",\"completeness\":\"metadata-only\",\"output_disposition\":\"not-captured\"}"
}

_redlog_prompt_command() {
  local exit_code=$?
  _REDLOG_TRAP_ARMED=
  # Once per shell, at the first prompt it can: see `_redlog_report_tools`, which
  # sets the flag when a report starts. Until then (RedLog down, or this shell
  # stopped) each prompt runs the recording check the DEBUG trap already pays
  # per command, so a stopped shell costs nothing new.
  if [[ -z "${_REDLOG_TOOLS_REPORTED:-}" ]]; then _redlog_report_tools; fi
  # Nothing started and nothing was deliberately skipped (recording stopped):
  # the line, if there was one, is the untraced kind.
  local histnum
  histnum=$(_redlog_history_number)
  if [[ -z "$_REDLOG_LAST_CMD" && -z "$_REDLOG_SKIP" ]]; then
    _redlog_record_untraced_line "$exit_code" "$histnum"
  fi
  _REDLOG_HISTNUM="${histnum:-0}"
  _REDLOG_SKIP=""
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
      extra="{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0},\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"source\":\"$_REDLOG_EVENT_SOURCE\",\"completeness\":\"metadata-only\",\"output_disposition\":\"$disposition\"$_REDLOG_CMD_CAPTURE}"
    fi
    _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" "$extra"
    _REDLOG_LAST_CMD=""
    _REDLOG_CMD_START=""
    _REDLOG_CMD_ID=""
    _REDLOG_CMD_CLASS=""
    _REDLOG_CMD_CAPTURE=""
  fi
  return $exit_code
}

# Empty history at source time is number 0, so a first line that is untraced
# is still number 1 and is seen.
_REDLOG_HISTNUM=$(_redlog_history_number)
: "${_REDLOG_HISTNUM:=0}"
# The trap itself is installed from the prompt command at the first prompt,
# behind any trap already there (see `_redlog_trap_plan`). Nothing is recorded
# before that prompt either way: the trap only counts while armed, and arming
# is the last thing the prompt command does.
#
# The operator's PROMPT_COMMAND runs between the two, whole. Bash 5.1 lets it be
# an array, each element a command of its own; `${PROMPT_COMMAND:-}` is element
# 0 alone, so the rest ran after `_redlog_arm`, armed, and were recorded as
# things the operator typed. An array is wrapped as an array. Before 5.1 an
# array PROMPT_COMMAND is not run as a prompt command at all (bash reads
# element 0 as the string it is), so those versions take the string path as
# they always did. `declare -p`, not `${PROMPT_COMMAND@a}`: the latter is a
# syntax error on 3.2, and a sourced file that does not parse loads nothing.
#
# `$(trap -p DEBUG)` and the `trap` are commands of the prompt command, not a
# function's, for the reason given at `_redlog_trap_plan`. The read costs one
# `$( )` a prompt, as `history 1` already does twice. All of it runs disarmed.
_redlog_pc_plan='_redlog_trap_plan "$(trap -p DEBUG)"'
_redlog_pc_set='[[ -z "$_REDLOG_TRAP_NEXT" ]] || trap -- "$_REDLOG_TRAP_NEXT" DEBUG'
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) \
   && [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(_redlog_prompt_command "${PROMPT_COMMAND[@]}" "$_redlog_pc_plan" "$_redlog_pc_set" _redlog_arm)
else
  _redlog_user_pc="${PROMPT_COMMAND:-}"
  # A trailing `;` or blank in the operator's value would make `;;` a syntax error.
  _redlog_user_pc="${_redlog_user_pc%"${_redlog_user_pc##*[![:space:];]}"}"
  if [[ -n "$_redlog_user_pc" ]]; then
    PROMPT_COMMAND="_redlog_prompt_command;${_redlog_user_pc};${_redlog_pc_plan};${_redlog_pc_set};_redlog_arm"
  else
    PROMPT_COMMAND="_redlog_prompt_command;${_redlog_pc_plan};${_redlog_pc_set};_redlog_arm"
  fi
  unset _redlog_user_pc
fi
unset _redlog_pc_plan _redlog_pc_set
# A relayed command's directory is removed by the NEXT prompt command. `exit` is
# a relayed command like any other, and no prompt follows it, so every shell
# closed on purpose left one behind (#296). Nothing here restores the
# descriptors: the shell is ending, and the relay treats a missing directory as
# the end of the command (`redlog-relay.py`, the `not os.path.isdir` test).
_redlog_exit_cleanup() {
  [[ -n "${_REDLOG_RELAY_DIR:-}" ]] && rm -rf "$_REDLOG_RELAY_DIR" 2>/dev/null
  return 0
}

# Bash keeps one EXIT trap, and the operator may already hold it. Theirs goes
# first and ours is added to it, as `_redlog_trap_plan` does for DEBUG. The trap
# is read through a file because `$(trap -p)` shows nothing before bash 4.4 (a
# command substitution starts with the traps reset); trusting an empty answer
# there would replace the operator's trap. With no file to read it, nothing is
# installed and the sweep at the next load stays the backstop. A trap the
# operator sets AFTER this loads replaces ours; the same backstop applies.
_redlog_install_exit_cleanup() {
  local file body=""
  file=$(mktemp "${TMPDIR:-/tmp}/redlog-exittrap.XXXXXX" 2>/dev/null) || return 0
  trap -p EXIT >"$file" 2>/dev/null
  body=$(<"$file")
  rm -f "$file"
  [[ "$body" == *_redlog_exit_cleanup* ]] && return 0
  if [[ -n "$body" ]]; then
    eval "set -- $body"
    # A newline, not `;`: the operator's last line may end in a comment.
    trap -- "$3"$'\n''_redlog_exit_cleanup' EXIT
  else
    trap '_redlog_exit_cleanup' EXIT
  fi
}
_redlog_install_exit_cleanup

# Pin this terminal's identity and starting state before the first prompt.
# `begin` is idempotent: re-sourcing does not undo a `redlog stop`.
_redlog_state --action begin >/dev/null 2>&1
# Behind the prompt: with thousands left over it is not something to wait for.
( _redlog_sweep_relay_dirs </dev/null >/dev/null 2>&1 & )
_redlog_announce_shell
