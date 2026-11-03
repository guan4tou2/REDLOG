#!/usr/bin/env zsh
# RedLog Zsh adapter — lifecycle only. Transport and redlog-run live in
# shell-common.sh so every POSIX adapter emits the same event contract.

if [[ -z "${ZSH_VERSION:-}" ]]; then
  print -u2 'redlog: shell-zsh-hook.zsh must be sourced by zsh'
  return 1 2>/dev/null || exit 1
fi

# Sourced twice from one rc (a relative and an absolute path to the same file
# are the usual way) the banner printed twice and the prompt hooks registered
# twice. Plain, un-exported: a child shell is a new interpreter and must load.
[[ "${_REDLOG_HOOK_LOADED_IN:-}" == "$$" ]] && return 0

_redlog_adapter_dir="${${(%):-%N}:A:h}"

# Local identity describes this interpreter; the exported value lets a
# standalone sender identify its caller without guessing from $SHELL (#325).
_REDLOG_ADAPTER_SHELL=zsh
export REDLOG_SHELL=zsh
# shellcheck source=shell-common.sh
source "$_redlog_adapter_dir/shell-common.sh"
unset _redlog_adapter_dir
_redlog_terminal_allowed || return 0
_REDLOG_HOOK_LOADED_IN=$$

# EPOCHREALTIME, for the event payload (shell-common.sh builds it without
# starting python3 when it can). bash has it built in from 5.0; zsh needs this.
zmodload zsh/datetime 2>/dev/null

# Explicit PTY capture owns this child shell; avoid unpinned duplicate events.
[[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0

# The embedded pane owns the provenance even when this adapter relays output.
# `captured_by` names the recorder; `source` must keep the pane identity so
# ingest can attach its .cast and health can distinguish it from an external shell.
_REDLOG_EVENT_SOURCE=auto-relay
[[ "${REDLOG_TERMINAL:-}" == "1" ]] && _REDLOG_EVENT_SOURCE=builtin-terminal

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
#
# The answer is a function of the line and of two files — the shipped policy
# beside the relay and the operator's overlay — so it is remembered per line,
# and forgotten the moment either file is replaced. A `python3` per command to
# re-derive `ls` is `relayed` was the largest single cost the adapter had
# (#288). `redlog class` rewrites the overlay by rename, so its inode changes
# even inside one clock tick; the signature carries inode, size and mtime, read
# with zsh's own `zstat` rather than a process. Without that builtin nothing is
# cached and every command asks, which is the old behaviour.
#
# The result is left in REPLY, not printed: capturing stdout is a fork, and a
# cache written inside `$( )` would be lost with the subshell.
zmodload -F zsh/stat b:zstat 2>/dev/null
typeset -gA _REDLOG_CLASS_CACHE
typeset -g _REDLOG_CLASS_SIG=""
# Not exported: a child shell reports for itself.
typeset -g _REDLOG_TOOLS_REPORTED=""
# Assigned by shell-common.sh functions the first prompt now reaches; declared
# here so WARN_CREATE_GLOBAL stays quiet until the first command, as before.
typeset -g _REDLOG_DIR _redlog_shell

_redlog_policy_sig() {
  REPLY=""
  (( $+builtins[zstat] )) || return 1
  local home=$HOME f
  [[ -n "${_REDLOG_DIR:-}" ]] && home="${_REDLOG_DIR:h}"
  local -a st
  # Three files decide a class: the shipped defaults, the operator's overlay,
  # and the plugins' profiles (#499). A plugin installed while this shell is
  # open writes the third, and the answers cached before it are wrong.
  for f in "${_REDLOG_RELAY:h}/command-class.json" "$home/.redlog/command-class.json" "$home/.redlog/terminal-profiles.json"; do
    # inode, size, mtime, ctime — fields 2, 8, 10 and 11 of a plain `zstat -A`.
    if zstat -A st -- "$f" 2>/dev/null; then
      REPLY+="${st[2]}:${st[8]}:${st[10]}:${st[11]}|"
    else
      REPLY+="absent|"
    fi
  done
  REPLY+="$home"
}

_redlog_class_of() {
  local line="$1" sig=""
  REPLY=""
  if _redlog_policy_sig; then
    sig=$REPLY
    if [[ "$sig" != "$_REDLOG_CLASS_SIG" ]]; then
      _REDLOG_CLASS_CACHE=()
      _REDLOG_CLASS_SIG=$sig
    fi
    if [[ -n "$line" && -n "${_REDLOG_CLASS_CACHE[$line]-}" ]]; then
      REPLY=${_REDLOG_CLASS_CACHE[$line]}
      return 0
    fi
  fi
  local -a words
  words=(${(z)line})
  # Both: the argv for the program lookup, and the raw line for the shapes the
  # relay has to decline — a pipeline with a pager in it, a redirection the
  # operator has already made (FR-029).
  REPLY=$(python3 "$_REDLOG_RELAY" classify --home "$(_redlog_home)" \
    --command-line "$line" -- "${words[@]}" 2>/dev/null)
  # Only an answer is kept: an empty one is python3 failing, and remembering
  # that would make one bad moment permanent.
  if [[ -n "$sig" && -n "$line" && -n "$REPLY" ]]; then
    (( ${#_REDLOG_CLASS_CACHE} >= 512 )) && _REDLOG_CLASS_CACHE=()
    _REDLOG_CLASS_CACHE[$line]=$REPLY
  fi
}

# --- This terminal's own state (spec 052 US2) ---
#
# One id per shell, minted once, naming the file this terminal and RedLog both
# read. `redlog stop` writes it and the next `preexec` reads it — which is the
# whole of FR-022: a stop held in a shell variable survives neither a subshell
# nor a prompt, and an operator who types `redlog stop` before a client's
# credential and sees it recorded anyway uninstalls the tool.
_REDLOG_SESSION_ID=${REDLOG_TERMINAL_ID:-$(_redlog_new_command_id)}
export _REDLOG_SESSION_ID
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
  _redlog_terminal_allowed || return 1
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
        "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"operator\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
      print -- "[redlog] recording stopped in this terminal — redlog start to resume"
      ;;
    start)
      _redlog_state --action start >/dev/null
      if _redlog_is_recording; then
        _redlog_send_event "capture_resumed" "redlog start" \
          "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
      fi
      _redlog_state --action show --format human
      print
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
          local prog
          for prog in ${(f)"$(python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" --field pty 2>/dev/null)"}; do
            [[ -n "$prog" ]] || continue
            if _redlog_is_user_function "$prog"; then
              print -- "$prog is your own function, so it is not PTY-recorded"
            elif whence -p -- "$prog" >/dev/null 2>&1 && ! _redlog_is_pty_wrapper "$prog"; then
              # Wrappers are installed once, when a terminal starts. A program
              # that joined the class since (a plugin's profile, `redlog class
              # add pty`) is wrapped in the next terminal and not in this one.
              # One that was already in the class but had no executable then
              # is not wrapped by a PATH entry added since, so that is said
              # as it is rather than as a new terminal's doing.
              if (( ${_REDLOG_PTY_NOT_ON_PATH[(Ie)$prog]} )); then
                print -- "$prog is not PTY-recorded: it was not on PATH when the RedLog hook loaded"
              else
                print -- "$prog is PTY-recorded in a new terminal, not this one"
              fi
            fi
          done
          print
          ;;
        add)
          if [[ -z "${2:-}" || -z "${3:-}" ]]; then
            print -u2 -- 'usage: redlog class add relayed|pty|native <command>'
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" \
            --action add --field "$2" --command "$3" >/dev/null
          # 3 is a name the wrapper cannot be built from, 4 an overlay that was
          # not rewritten because it could not be read (the relay said why);
          # anything else is the class.
          case $? in
            0) ;;
            3) print -u2 -- "[redlog] not a command name: $3 (letters, digits, . _ + - only)"; return 2 ;;
            4) return 2 ;;
            *) print -u2 -- "[redlog] no such class: $2"; return 2 ;;
          esac
          print -- "[redlog] $3 is now $2"
          # FR-028. The cost is not obvious and it is paid in the middle of an
          # engagement, on the command the operator cares most about.
          # An `if`, not `&&`: as the last command, a false test would be
          # the function's status and a successful add would return 1.
          if [[ "$2" == "pty" ]]; then
            print -- "[redlog] note: a pty-captured command cannot be suspended locally — Ctrl-Z will not return you to this shell"
          fi
          ;;
        remove)
          if [[ -z "${2:-}" ]]; then
            print -u2 -- 'usage: redlog class remove <command>'
            return 2
          fi
          python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" \
            --action remove --command "$2" >/dev/null
          # The relay has said why when it did not rewrite the overlay.
          case $? in
            0) ;;
            3) print -u2 -- "[redlog] not a command name: $2 (letters, digits, . _ + - only)"; return 2 ;;
            *) return 2 ;;
          esac
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
  # RedLog owns and rotates its built-in panes' enrollment. External shells
  # keep the stop-on-switch pin; they must never be silently rebound.
  [[ "${REDLOG_TERMINAL:-}" == "1" ]] && return
  local file
  file=$(_redlog_identity_file)
  [[ -f "$file" ]] || return
  local -a st
  # Fractional seconds, not `+mtime` alone: that is whole seconds, so a switch
  # written in the same second the terminal started in (a fast machine, or a
  # script) looks like no change and every later command is filed under the
  # old project.
  zstat -F '%s.%N' -A st +mtime "$file" 2>/dev/null || return
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
    "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"project-switched\",\"engagement_id\":\"$pinned\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
  print -u2 -- "[redlog] the project changed — this terminal stopped recording; open a new terminal for the new project"
}

zmodload zsh/zselect 2>/dev/null

# Give the command a pseudo-terminal for stdout and for stderr, each read by
# the relay, in place of a pipe (issue #288). The command still gets the REAL
# terminal on stdin, which is what keeps job control and `nc` alone, but it now
# sees a terminal on the other two descriptors — so `ls` columns and colour,
# `isatty`, and the window size are what they are without RedLog.
#
# The relay makes the pairs and says where they are; this opens them and says
# so. Any failure leaves the descriptors as they were and the command runs
# unrecorded — unrecorded is bad, a wedged prompt is worse (FR-009).
#
# A terminal on stdout and stderr has one cost: a pager. `git log` and `man`
# start `less` the moment stdout is a terminal, and `less` takes its keyboard
# and its raw mode from stderr — which is now a pty nobody types into, so the
# pager draws a page and never reads a key. A pipe used to prevent this by
# accident. The pagers are switched off for the length of a diverted command,
# which is what a pipe gave, and put back at the prompt.
typeset -ga _REDLOG_PAGER_VARS=(PAGER GIT_PAGER MANPAGER SYSTEMD_PAGER)
typeset -gA _REDLOG_PAGER_SAVED

_redlog_pagers_off() {
  local name
  _REDLOG_PAGER_SAVED=()
  for name in $_REDLOG_PAGER_VARS; do
    if [[ -n "${(P)name+set}" ]]; then
      _REDLOG_PAGER_SAVED[$name]="${(P)name}"
    else
      _REDLOG_PAGER_SAVED[$name]='__redlog_unset__'
    fi
    export $name=cat
  done
}

_redlog_pagers_restore() {
  local name
  for name in ${(k)_REDLOG_PAGER_SAVED}; do
    if [[ "${_REDLOG_PAGER_SAVED[$name]}" == '__redlog_unset__' ]]; then
      unset $name
    else
      export $name="${_REDLOG_PAGER_SAVED[$name]}"
    fi
  done
  _REDLOG_PAGER_SAVED=()
}

_redlog_divert() {
  local dir=$1 i=0
  exec {_REDLOG_SAVED_OUT}>&1 {_REDLOG_SAVED_ERR}>&2 || return 1
  local home=$HOME
  [[ -n "${_REDLOG_DIR:-}" ]] && home="${_REDLOG_DIR:h}"
  # The command id, source and home let the relay send what a background job
  # prints after the prompt is back, attributed to this command.
  python3 "$_REDLOG_RELAY" pty --dir "$dir" --err-fd 3 \
    --max-bytes "$_REDLOG_MAX_BYTES" --command-id "$_REDLOG_CMD_ID" \
    --source "$_REDLOG_EVENT_SOURCE" --captured-by auto-relay --home "$home" \
    >&$_REDLOG_SAVED_OUT 3>&$_REDLOG_SAVED_ERR &!
  _REDLOG_RELAY_PID=$!
  while [[ ! -s "$dir/pts" ]]; do
    (( i++ >= 500 )) && break
    # `zselect -t` returns non-zero when it times out, which is its normal
    # outcome here, so the fallback is chosen by whether the builtin exists.
    if (( $+builtins[zselect] )); then zselect -t 1; else command sleep 0.01; fi
  done
  local -a pts
  # The relay may never have written `pts` (it timed out above). `$(<file)` then
  # reports "no such file or directory" from the shell itself, which a `2>` on
  # the substitution does not catch and which lands in the operator's terminal.
  # Read it only when it is there; an empty `pts` falls to the failure path.
  [[ -s "$dir/pts" ]] && pts=("${(@f)$(<"$dir/pts")}")
  if [[ -n "$pts[1]" && -n "$pts[2]" ]] && exec 1>|"$pts[1]" 2>|"$pts[2]"; then
    : >"$dir/opened"
    _redlog_pagers_off
    # Restore descriptors and drain the command before prompt/theme hooks draw.
    # Preserve their relative order; only our cleanup must run first.
    precmd_functions=(_redlog_precmd "${(@)precmd_functions:#_redlog_precmd}")
    return 0
  fi
  exec 1>&$_REDLOG_SAVED_OUT 2>&$_REDLOG_SAVED_ERR
  exec {_REDLOG_SAVED_OUT}>&- {_REDLOG_SAVED_ERR}>&-
  kill "$_REDLOG_RELAY_PID" 2>/dev/null
  return 1
}

_redlog_preexec() {
  _redlog_check_project
  _REDLOG_LAST_CMD=""
  _REDLOG_CMD_START=""
  _REDLOG_CMD_ID=""
  _REDLOG_CMD_CLASS=""
  _REDLOG_CMD_CAPTURE=""
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
    _redlog_class_of "$1"
    _REDLOG_CMD_CLASS=$REPLY
  fi
  : ${_REDLOG_CMD_CLASS:=native}

  # `class` is the policy; it is not a claim about how this run was captured.
  # A `pty` run is PTY-recorded only when the word typed is RedLog's wrapper
  # function. Otherwise it ran native, and the record says so beside the class
  # rather than letting `pty` read as "PTY-captured": the operator's own
  # function of that name (#288), or no wrapper at all — a program that joined
  # the class after this shell started, a plugin's, `sudo ssh`, `/usr/bin/ssh`.
  _REDLOG_CMD_CAPTURE=""
  if [[ "$_REDLOG_CMD_CLASS" == "pty" ]]; then
    local -a _redlog_words
    _redlog_words=(${(z)1})
    if _redlog_is_user_function "${_redlog_words[1]:-}"; then
      _REDLOG_CMD_CAPTURE=',"capture_mode":"native","capture_reason":"existing-shell-function"'
    elif ! _redlog_is_pty_wrapper "${_redlog_words[1]:-}"; then
      _REDLOG_CMD_CAPTURE=',"capture_mode":"native","capture_reason":"no-pty-wrapper"'
    fi
  fi

  if [[ "$_REDLOG_CMD_CLASS" == "relayed" ]]; then
    # A failure anywhere here leaves the descriptors untouched and the command
    # runs unrecorded. Unrecorded is bad; a wedged prompt is worse (FR-009).
    # The shell's pid is in the name so a later shell can tell whose it was.
    # A full template, not `-t`: BSD mktemp's `-t` ignores $TMPDIR, and the
    # sweep (shell-common.sh) looks for leftovers in $TMPDIR.
    if _REDLOG_RELAY_DIR=$(mktemp -d "${${TMPDIR:-/tmp}%/}/redlog-relay.$$.XXXXXX" 2>/dev/null) \
       && _redlog_divert "$_REDLOG_RELAY_DIR"; then
      :
    else
      rm -rf "$_REDLOG_RELAY_DIR" 2>/dev/null
      _REDLOG_RELAY_DIR=""
      _REDLOG_CMD_CLASS="native"
    fi
  fi

  _redlog_send_event "command_start" "$1" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"class\":\"$_REDLOG_CMD_CLASS\",\"source\":\"$_REDLOG_EVENT_SOURCE\"$_REDLOG_CMD_CAPTURE}"
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
  # The text of each command is still kept for replay (#315) — `_redlog_send_event`
  # spools it with nowhere to send it — but not what it printed, which only a
  # live relay can hold. Saying "unrecorded" would be the other way to mislead.
  if [[ ! -s "$(_redlog_identity_file)" ]]; then
    print -u2 -- "[redlog] RedLog is not reachable — no project is open; commands and output are not being saved"
  else
    print -u2 -- "[redlog] RedLog is not reachable — commands are running without live recording; their text is kept for replay, their output is not"
  fi
}

_redlog_precmd() {
  local exit_code=$?
  # Once per shell, at the first prompt and ahead of the early return below,
  # which is what the first prompt takes: there is no command yet.
  # The flag is set by the function once a report has started. Until then (RedLog
  # down, or this shell stopped) each prompt runs the same recording check that
  # preexec already pays per command, so a stopped shell costs nothing new.
  if [[ -z "${_REDLOG_TOOLS_REPORTED:-}" ]]; then _redlog_report_tools; fi
  [[ -n "$_REDLOG_LAST_CMD" ]] || return

  _redlog_warn_unreachable

  local duration=0
  [[ -n "$_REDLOG_CMD_START" ]] && duration=$(( EPOCHSECONDS - _REDLOG_CMD_START ))

  local extra=""
  if [[ -n "$_REDLOG_RELAY_DIR" ]]; then
    # Putting the descriptors back is what gives the two relays their EOF.
    exec 1>&$_REDLOG_SAVED_OUT 2>&$_REDLOG_SAVED_ERR
    exec {_REDLOG_SAVED_OUT}>&- {_REDLOG_SAVED_ERR}>&-
    # Only this hook knows the command has finished. A transient EOF/EIO on
    # either PTY must not close a master while the command can still write.
    : >"$_REDLOG_RELAY_DIR/closed"
    _redlog_pagers_restore
    # O2: the body is read only after the component that owns the bytes has
    # finished draining. `finish` waits for both part files — each written
    # whole and renamed into place — rather than this function racing them.
    extra=$(python3 "$_REDLOG_RELAY" finish \
      --stdout-part "$_REDLOG_RELAY_DIR/stdout.json" \
      --stderr-part "$_REDLOG_RELAY_DIR/stderr.json" \
      --exit-code "$exit_code" --duration-sec "$duration" \
      --cwd "$PWD" --command-id "$_REDLOG_CMD_ID" \
      --command-line "$_REDLOG_LAST_CMD" \
      --captured-by auto-relay --source "$_REDLOG_EVENT_SOURCE" 2>/dev/null)
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
    extra="{\"exit_code\":$exit_code,\"duration_sec\":$duration,\"cwd\":\"${PWD//\"/\\\"}\",\"command_id\":\"$_REDLOG_CMD_ID\",\"source\":\"$_REDLOG_EVENT_SOURCE\",\"completeness\":\"metadata-only\",\"output_disposition\":\"$disposition\"$_REDLOG_CMD_CAPTURE}"
  fi

  _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" "$extra"
  _REDLOG_LAST_CMD=""
  _REDLOG_CMD_START=""
  _REDLOG_CMD_ID=""
  _REDLOG_CMD_CLASS=""
  _REDLOG_CMD_CAPTURE=""
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
#
# A function the operator already has under the program's name is theirs and
# is not wrapped (#288): replacing it would drop whatever it does, and with
# RedLog not recording the wrapper's fallback is `command ssh`, which is not
# their function either. That program is not PTY-recorded and runs native; it
# is still classed `pty`, so it is recorded as metadata only, `interactive`,
# like `sudo ssh`. The reverse order is the same outcome by the operator's own
# hand: a function defined AFTER this hook replaces RedLog's wrapper, and that
# program is not PTY-recorded either. `redlog class list` names the programs
# this applies to, and the program's `command_start`/`command_end` carry
# `capture_mode: native` and `capture_reason: existing-shell-function` beside
# `class: pty`, so the policy is not read as a claim about the run. A `pty`
# command whose typed word is not a wrapper at all (`sudo ssh`, a program added
# to the class after this shell started, one a plugin's tool profile named)
# says `capture_reason: no-pty-wrapper`, as the bash adapter does for every one.
#
# Wrappers are installed once, when this hook loads, and not re-applied at each
# prompt: a program added to the PTY class afterwards is wrapped in the next
# terminal. A wrapper needs a real program behind it — `whence -p` looks past
# functions and aliases, which `command -v` does not.
#
# RedLog's own wrapper is told apart by its body, which carries
# `_REDLOG_SESSION_HELPER` — so sourcing the hook again reinstalls it.
#
# The wrapper hands the helper this command's `command_id` in the environment,
# so the session's rows name the `command_start` they belong to (#296). An
# environment variable rather than an option: a helper older than this hook
# ignores it, where an unknown option would stop the operator's `ssh`.
_redlog_is_user_function() {
  [[ -n "${1:-}" ]] && (( $+functions[$1] )) && [[ "${functions[$1]}" != *_REDLOG_SESSION_HELPER* ]]
}

# The reverse: the name is RedLog's own PTY wrapper, so a `pty` run of it is
# PTY-recorded. Everything else typed for a `pty` program ran on the terminal.
_redlog_is_pty_wrapper() {
  [[ -n "${1:-}" ]] && (( $+functions[$1] )) && [[ "${functions[$1]}" == *_REDLOG_SESSION_HELPER* ]]
}

# The pty programs this hook found no executable for when it installed the
# wrappers. `redlog class list` tells these apart from a program that joined the
# class afterwards: a PATH entry added since does not wrap the first kind, and
# only a new terminal wraps the second. One array per load, no cost per prompt.
typeset -ga _REDLOG_PTY_NOT_ON_PATH
_REDLOG_PTY_NOT_ON_PATH=()

_redlog_install_pty_wrappers() {
  local prog
  _REDLOG_PTY_NOT_ON_PATH=()
  for prog in ${(f)"$(python3 "$_REDLOG_RELAY" policy --home "$(_redlog_home)" --field pty 2>/dev/null)"}; do
    [[ -n "$prog" ]] || continue
    # Only wrap what is actually here: an executable on PATH. A function named
    # `ssh` on a machine without ssh turns "command not found" into a confusing
    # python error, and `command -v` would call the operator's own function
    # "here".
    if ! whence -p -- "$prog" >/dev/null 2>&1; then
      _REDLOG_PTY_NOT_ON_PATH+=("$prog")
      continue
    fi
    _redlog_is_user_function "$prog" && continue
    # Read per call, like the adapter's own gate: `redlog stop` has to reach a
    # program already wrapped, and `redlog start` has to bring it back, in this
    # shell, without sourcing the hook again (#296).
    # The class is read per call too, from the same cache preexec uses, so
    # `redlog class add native ssh` takes ssh out of the recorder in this
    # shell instead of only printing that it did (#296).
    functions[$prog]='
      if _redlog_is_recording && _redlog_is_running && [[ -s "$(_redlog_identity_file)" ]] \
         && _redlog_class_of '"$prog"' && [[ "$REPLY" == pty ]]; then
        REDLOG_SESSION_COMMAND_ID="$_REDLOG_CMD_ID" python3 "$_REDLOG_SESSION_HELPER" --best-effort -- '"$prog"' "$@"
      else
        command '"$prog"' "$@"
      fi'
  done
}

# Pin this terminal's identity and its starting state before the first prompt.
# `begin` is idempotent — a state file that already exists is left alone, so
# re-sourcing the adapter does not undo a `redlog stop`.
_redlog_state --action begin >/dev/null 2>&1

# A relayed command's directory is removed by the NEXT prompt's `precmd`.
# `exit` is a relayed command like any other, and no prompt follows it, so every
# shell closed on purpose left one behind (#296). Nothing here restores the
# descriptors: the shell is ending, and the relay treats a missing directory as
# the end of the command (`redlog-relay.py`, the `not os.path.isdir` test).
_redlog_zshexit() {
  [[ -n "${_REDLOG_RELAY_DIR:-}" ]] && rm -rf "$_REDLOG_RELAY_DIR" 2>/dev/null
  return 0
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _redlog_preexec
add-zsh-hook precmd _redlog_precmd
add-zsh-hook zshexit _redlog_zshexit
_redlog_install_pty_wrappers
# Behind the prompt: with thousands left over it is not something to wait for.
( _redlog_sweep_relay_dirs </dev/null >/dev/null 2>&1 & )
_redlog_announce_shell
