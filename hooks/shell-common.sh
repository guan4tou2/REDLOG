#!/usr/bin/env bash
# Shared RedLog POSIX shell transport and explicit output-capture wrapper.
# Lifecycle integration belongs in shell-bash-hook.sh / shell-zsh-hook.zsh.
# This file is sourced by an adapter; do not source it directly.

_REDLOG_LAST_CMD=""
_REDLOG_CMD_START=""
# What the last send did with an event it could neither deliver nor spool:
# empty while events are delivered or kept, `unreachable` or `no-project` once
# one was dropped, `told` once the prompt has said so. See `_redlog_warn_unsaved`.
_REDLOG_UNSAVED=""
# Set when a terminal that loaded with no project open first sees one; cleared
# once the prompt has said so. See `_redlog_announce_adoption`.
_REDLOG_ADOPTED=""
# Results that helpers on the per-command path leave in a variable instead of
# printing, because capturing output is a fork. Made here, at load, so zsh's
# WARN_CREATE_GLOBAL has nothing to say when a function first assigns them.
_redlog_id="" _redlog_ns="" _redlog_text="" _redlog_path="" _redlog_count=0
_REDLOG_SESSION_HELPER="${_redlog_adapter_dir:-}/redlog-session.py"
_REDLOG_RELAY="${_redlog_adapter_dir:-}/redlog-relay.py"

redlog-session() {
  python3 "$_REDLOG_SESSION_HELPER" "$@"
}


# --- Resolve RedLog dir (token + port files) ---
# Native: $HOME/.redlog; WSL: auto-resolve from Windows %USERPROFILE%
_redlog_resolve_dir() {
  if [[ -f "$HOME/.redlog/api-token" ]]; then
    # Under WSL a native directory may be stale. Adopt it only while its own
    # token is accepted by what answers on its port; otherwise resolve the
    # Windows profile below (#326).
    #
    # /api/health is public, so it cannot say whether the token is current:
    # with mirrored networking 127.0.0.1:6660 here IS the Windows app, which
    # answers health for a leftover directory's port and then refuses its old
    # token, and every event was spooled where nothing drains it. /api/whoami
    # needs the token. 401 means the token is stale; 503 means the app is up
    # with no project open, so the token cannot be judged and the directory
    # is kept, as before; anything else (nothing listening) falls through.
    if [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
      echo "$HOME/.redlog"
      return
    fi
    local native_port="" native_code=""
    [[ -f "$HOME/.redlog/api-port" ]] && native_port=$(<"$HOME/.redlog/api-port")
    case "$native_port" in
      ''|*[!0-9]*) ;;
      *)
        # The token is read by curl from stdin config, not placed in argv.
        native_code=$(printf 'header = "Authorization: Bearer %s"\n' "$(<"$HOME/.redlog/api-token")" \
          | curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
            -K - "http://127.0.0.1:${native_port}/api/whoami" 2>/dev/null)
        case "$native_code" in
          200|503) echo "$HOME/.redlog"; return ;;
        esac ;;
    esac
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    # appendWindowsPath=false in /etc/wsl.conf leaves cmd.exe off PATH, and
    # then nothing resolved here and every event was dropped. wslpath maps the
    # drive through whatever automount root is configured.
    local win_profile win_cmd
    win_cmd=$(command -v cmd.exe) || win_cmd=$(wslpath -u 'C:\Windows\System32\cmd.exe' 2>/dev/null)
    # </dev/null: interop hands this shell's stdin to cmd.exe, which ran while
    # the hook was being sourced and swallowed every line piped in after it.
    win_profile=$("${win_cmd:-cmd.exe}" /c 'echo %USERPROFILE%' </dev/null 2>/dev/null | tr -d '\r')
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

# Application selection is independent of Bash/Zsh. Re-read before each command
# and send so narrowing the preference also stops already loaded adapters.
_redlog_terminal_allowed() {
  if [[ -z "${_REDLOG_DIR:-}" && -n "${WSL_DISTRO_NAME:-}" ]]; then
    _REDLOG_DIR=$(_redlog_resolve_dir) || return 1
    export _REDLOG_DIR
  fi
  local dir="${_REDLOG_DIR:-$HOME/.redlog}" wanted
  [[ -e "$dir/terminal-app" ]] || return 0
  { wanted=$(<"$dir/terminal-app"); } 2>/dev/null || return 1
  [[ "$wanted" == all ]] && return 0
  # Only the OS-origin resolver can attest a restricted source. No inherited
  # TERM_PROGRAM / WT_SESSION / REDLOG_TERMINAL flag is a proof of ownership.
  python3 "${_redlog_adapter_dir:-}/terminal_app.py" "$dir" >/dev/null 2>&1
}

# --- Resolve reachable host ---
# Both probes are bounded by --max-time, not only by --connect-timeout. A
# connect timeout expires when nothing *accepts*; a process that accepts the
# socket and then never answers — RedLog mid-crash, a port inherited by
# something else, an SSH forward whose far end is gone — satisfies the connect
# and then waits forever. This runs from preexec on the operator's prompt, so
# "forever" means the engagement's shell is wedged by its own logger. Bounded,
# the worst case is 127.0.0.1 and the gateway in turn, once per shell:
# _REDLOG_HOST is exported after the first resolve.
_redlog_resolve_host() {
  local port="$1"
  if curl --noproxy '*' -sf --connect-timeout 1 --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "127.0.0.1"
    return
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    local gw
    gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
    if [[ -n "$gw" ]] && curl --noproxy '*' -sf --connect-timeout 1 --max-time 2 "http://${gw}:${port}/api/health" >/dev/null 2>&1; then
      echo "$gw"
      return
    fi
  fi
  echo "127.0.0.1"
}

# The correlation key for one command. `command_start`, every `command_output`
# chunk and `command_end` carry it, and it is the ONLY thing that says which
# command a chunk belongs to — never a marker in the bytes, which the command's
# own output can forge (FR-002, contracts/events.md).
#
# Nanoseconds, pid and $RANDOM: unique within a machine without reaching for
# uuidgen, which is not everywhere. `date +%s%N` prints a literal N where it is
# not GNU date, so that case falls back rather than minting a shared id.
_redlog_new_command_id() {
  _redlog_mint_command_id
  printf '%s' "$_redlog_id"
}

# The same id, left in `_redlog_id` instead of printed: `$(…)` around the
# function above is a fork, and with `date` inside it a second process, on
# every command. A shell with EPOCHREALTIME (zsh with zsh/datetime, bash 5)
# has the clock itself and starts nothing; its fraction is padded or cut to the
# nine digits `date +%s%N` prints, so the id keeps one shape whichever clock
# minted it. A locale that writes the fraction with a comma is not that shape
# and goes to `date`, as every shell did before.
_redlog_mint_command_id() {
  _redlog_ns_stamp
  local stamp=$_redlog_ns
  case "$stamp" in
    ''|*N*) stamp="$(date +%s)${RANDOM:-0}" ;;
  esac
  _redlog_id="$stamp-$$-${RANDOM:-0}"
}

# What `date +%s%N` prints, in `_redlog_ns`, without the process where the
# shell has the clock (see above). Where it does not, it is `date`'s answer as
# it was, a literal N included.
_redlog_ns_stamp() {
  local now="${EPOCHREALTIME:-}" frac
  if [[ "$now" == [0-9]*.[0-9]* && "$now" != *[!0-9.]* ]]; then
    frac="${now#*.}000000000"
    _redlog_ns="${now%%.*}${frac:0:9}"
  else
    _redlog_ns=$(date +%s%N 2>/dev/null)
  fi
}

# How many `*.json` files wait in the spool, in `_redlog_count`: the number
# `find DIR -maxdepth 1 -name '*.json' | wc -l` gave, which was three
# processes on every spooled event. Dot files count, as they did for find, and
# case matters, whatever the operator's glob options say. zsh counts in this
# shell with its options reset for the function alone; bash counts in a
# subshell, so nothing it sets can outlive the count.
_redlog_count_waiting() {
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    # -R: every option, not only the emulation's own — `emulate -L zsh`
    # alone leaves an operator's NO_CASE_GLOB in force.
    emulate -LR zsh
    setopt nullglob globdots
    local -a waiting
    # `oN`: unsorted. Sorting thousands of names in a UTF-8 locale cost more
    # than the processes this replaced (measured: ~140 ms at 5000). In `eval`
    # because bash reads this file too, and a glob qualifier does not parse.
    eval 'waiting=( "$1"/*.json(oN) )'
    _redlog_count=${#waiting[@]}
  else
    # LC_ALL=C for the same reason: bash always sorts a glob, and collating
    # is what made it slow. Byte order matches `*.json` exactly as find did.
    _redlog_count=$(LC_ALL=C; unset GLOBIGNORE; shopt -s nullglob dotglob; shopt -u nocaseglob failglob 2>/dev/null
      set +f; waiting=( "$1"/*.json ); printf '%s' "${#waiting[@]}")
  fi
}

# A relayed command's working directory, `redlog-relay.<shell pid>.<random>` in
# $TMPDIR, is removed by the shell at the next prompt. A shell killed while the
# command runs never gets there, and the directories piled up (#296: 3,776, 55 MB,
# on one box). A shell cannot clean up after its own SIGKILL, so the next shell
# does, once, as the hook loads.
#
# A directory goes only when its owner is known to be gone:
#   - the pid in the name is not a process (`kill -0`), or
#   - the name carries no pid (the form zsh used to make), no running process
#     names the directory — the relay is started with `--dir <it>` — and it is
#     older than a minute, so one a shell has just made and not yet handed to
#     its relay is left alone.
# Only this user's directories, and only real directories, are considered.
# `kill -0` also fails for a pid that is alive but not ours, which for a
# directory of ours means the pid was reused after its owner died.
_redlog_sweep_relay_dirs() {
  local tmp="${TMPDIR:-/tmp}" dir name owner procs
  tmp=${tmp%/}
  procs=$(ps -eo args= 2>/dev/null)
  find "$tmp" -maxdepth 1 -type d -user "$(id -u)" \
    \( -name 'redlog-relay.*.*' -o \( -name 'redlog-relay.*' -mmin +1 \) \) 2>/dev/null |
  while IFS= read -r dir; do
    name=${dir##*/}
    case "$name" in *[!A-Za-z0-9.-]*) continue ;; esac
    owner=${name#redlog-relay.}
    case "$owner" in
      *.*) owner=${owner%%.*} ;;
      *) owner="" ;;
    esac
    case "$owner" in
      '') [[ -n "$procs" && "$procs" != *"$dir"* ]] || continue ;;
      *[!0-9]*) continue ;;
      *) kill -0 "$owner" 2>/dev/null && continue ;;
    esac
    rm -rf "$dir" 2>/dev/null
  done
}

# Where the active project's identity lives. Paths into the RedLog directory
# belong here rather than in an adapter: `shell-adapter-boundaries.test.ts`
# holds that line, and it is the reason every POSIX adapter emits the same
# contract instead of each one knowing its own layout.
_redlog_identity_file() {
  _redlog_identity_path
  printf '%s' "$_redlog_path"
}

# The same path in `_redlog_path`, for a caller on the per-command path, where
# `$(_redlog_identity_file)` would be a fork for a string.
_redlog_identity_path() {
  _redlog_path="${_REDLOG_DIR:-$HOME/.redlog}/active-identity.json"
}

_redlog_is_running() {
  [[ -n "${_REDLOG_DIR:-}" ]] || { _REDLOG_DIR=$(_redlog_resolve_dir) || return 1; export _REDLOG_DIR; }
  [[ -f "$_REDLOG_DIR/api-port" ]] && [[ -f "$_REDLOG_DIR/api-token" ]]
}

# A whole file into `_redlog_text`, with its trailing newlines removed — what
# `$(<file)` gives — by the `read` builtin. bash forks for `$(<file)` (zsh does
# not), and this runs twice an event. Fails, leaving it empty, when the file
# cannot be read.
_redlog_read_text() {
  _redlog_text=""
  { IFS= read -r -d '' _redlog_text <"$1"; } 2>/dev/null
  [[ -r "$1" ]] || return 1
  while [[ "$_redlog_text" == *$'\n' ]]; do _redlog_text=${_redlog_text%$'\n'}; done
  return 0
}

# Whether a terminal state file says this terminal records: what
# `grep -q '"recording"[[:space:]]*:[[:space:]]*true' FILE` answered, without
# starting grep, which both adapters did at every command. grep reads lines,
# so a newline is not space to it; here it becomes `|`, which the pattern
# cannot match either, so a match cannot cross a line.
# zsh's `=~` sets MATCH and match; they are made local so it creates nothing.
_redlog_state_records() {
  local re='"recording"[[:space:]]*:[[:space:]]*true' MATCH MBEGIN MEND
  local -a match mbegin mend
  _redlog_read_text "$1" || return 1
  _redlog_text=${_redlog_text//$'\n'/|}
  [[ "$_redlog_text" =~ $re ]]
}

# FR-010, for both adapters. The dangerous outcome is not a missing command —
# it is a command from engagement A filed under engagement B, which is a lie in
# a document a client reads, written by the tool whose whole job is to be
# believable. Every event carries whatever identity the file holds when it is
# sent, and RedLog accepts any event that names the project it has open, so a
# terminal left open across a switch would write into the new project unless
# it stops itself first.
#
# RedLog rewrites the identity file when the operator opens another project.
# The adapter calls this before each command line; it compares a stamp of the
# file with the one it saw last, and only a changed stamp pays for the relay
# call that compares the pinned engagement with the current one. The relay
# then marks this terminal stopped, `project-switched`, and nothing — not
# `redlog start` — undoes that (redlog-relay.py, `apply_terminal_action`).
#
# The stamp is `_redlog_identity_stamp`'s, left in `_redlog_stamp`: the file's
# contents, read by the `read` builtin, so the common case costs an open and
# no process. Contents rather than an mtime because bash 3.2 has no builtin
# that reads one, and `stat` is a process with two incompatible spellings
# (BSD, GNU). The zsh adapter replaces the stamp with `zstat`'s mtime, which
# is also a builtin there. An empty read is a file being rewritten (RedLog
# truncates, then writes) and is not a stamp.
_redlog_identity_stamp() {
  local file="${_REDLOG_DIR:-$HOME/.redlog}/active-identity.json"
  _redlog_stamp=""
  [[ -f "$file" ]] || return 1
  # Ends at EOF, which is `read`'s status 1; what it read is the answer.
  { IFS= read -r -d '' _redlog_stamp <"$file"; } 2>/dev/null
  [[ -n "$_redlog_stamp" ]]
}

_redlog_check_project() {
  # RedLog owns and rotates its built-in panes' enrollment. External shells
  # keep the stop-on-switch pin; they must never be silently rebound.
  [[ "${REDLOG_TERMINAL:-}" == "1" ]] && return 0
  _redlog_identity_stamp || return 0
  [[ "$_redlog_stamp" == "${_REDLOG_IDENTITY_SEEN:-}" ]] && return 0
  # The first sight of the file is the pin itself, not a switch. The adapter
  # seeds the stamp as it loads, so arriving here means this terminal loaded
  # with no project open and is adopted by the one RedLog opened since: said
  # at the next prompt (`_redlog_announce_adoption`).
  if [[ -z "${_REDLOG_IDENTITY_SEEN:-}" ]]; then
    _REDLOG_IDENTITY_SEEN=$_redlog_stamp
    _REDLOG_ADOPTED=1
    return 0
  fi
  _REDLOG_IDENTITY_SEEN=$_redlog_stamp

  local after pinned
  after=$(_redlog_state --action project)
  [[ "$after" == *project-switched* ]] || return 0
  [[ -n "${_REDLOG_ANNOUNCED_SWITCH:-}" ]] && return 0
  _REDLOG_ANNOUNCED_SWITCH=1

  # The pin is never updated, so the state still names the project whose work
  # just stopped. The row lands in whichever project RedLog has open now —
  # that is where someone wondering why this terminal went quiet will be
  # looking — and it names the old one explicitly rather than letting the
  # attribution speak for it. Cut out by expansion, not `=~`: the capture
  # lands in BASH_REMATCH in bash and in `match` in zsh, depending on options.
  pinned=${after#*\"engagementId\":}
  pinned=${pinned#"${pinned%%[![:space:]]*}"}
  case "$pinned" in
    \"*) pinned=${pinned#\"}; pinned=${pinned%%\"*} ;;
    *) pinned="" ;;
  esac
  _redlog_send_event "session_end" "" \
    "{\"session_id\":\"$_REDLOG_SESSION_ID\",\"reason\":\"project-switched\",\"engagement_id\":\"$pinned\",\"source\":\"$_REDLOG_EVENT_SOURCE\"}"
  printf '%s\n' "[redlog] the project changed — this terminal stopped recording; open a new terminal for the new project" >&2
}

# A JSON string's body, for input already known to be printable ASCII, where a
# backslash and a double quote are the only two characters that need escaping.
# The result is left in `_redlog_json` rather than printed: capturing stdout is
# a fork, and not forking is what this is for.
_redlog_json_quote() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  _redlog_json=$s
}

# Adapter identity is process-local; $SHELL describes the login shell.
# Resolve direct uses of this shared file from the running interpreter, and
# leave the result in a variable to avoid a fork on every event (#325).
_redlog_adapter_shell() {
  local name="${_REDLOG_ADAPTER_SHELL:-}"
  if [[ -z "$name" ]]; then
    if [[ -n "${ZSH_VERSION:-}" ]]; then
      name=zsh
    elif [[ -n "${BASH_VERSION:-}" ]]; then
      name=bash
    fi
  fi
  _redlog_shell="${name:-unknown}"
}

# Which tools this shell's PATH reaches, written by `redlog-relay.py detect` for
# RedLog to display (#499). Called once per shell, at its first prompt, by the
# adapter: the rc line that sources the hook is appended at install, so any PATH
# line a later installer adds comes after it and is only in effect by then.
# Behind the prompt and silent; what it finds changes nothing the adapter does.
#
# Only while RedLog is reachable and this shell is recording: after `redlog stop`
# RedLog writes nothing new for it. The flag is set here, once a report has
# actually started, so a shell that begins stopped reports at its first prompt
# after `redlog start`.
_redlog_report_tools() {
  _redlog_is_running || return 0
  _redlog_is_recording || return 0
  _REDLOG_TOOLS_REPORTED=1
  _redlog_adapter_shell
  ( python3 "$_REDLOG_RELAY" detect --home "${_REDLOG_DIR%/*}" --session "${_REDLOG_SESSION_ID:-}" \
      --shell "$_redlog_shell" </dev/null >/dev/null 2>&1 & )
}

# The event payload, written without starting a process (#288). Returns 1 —
# writing nothing it would want kept — whenever it cannot be sure the JSON is
# what the python builder in `_redlog_send_event` would have produced, and the
# caller then runs that one. So this is only ever the fast case, never the
# other behaviour: it declines
#
#   - a command, subtype, shell name or terminal id that is not printable ASCII.
#     Anything else needs real escaping or decoding, and a Chinese command is
#     exactly the one that must not be mangled;
#   - an `extra` that is large or holds a control character. A command_end
#     carries bodies up to megabytes, and the pattern removals below are not
#     built for that; a control character is JSON that is invalid, or
#     pretty-printed, and python is the one that knows which;
#   - an `extra` that is not one `{...}` object;
#   - no EPOCHREALTIME (bash before 5, zsh without zsh/datetime), because the
#     time has to be when the command ran and `date` is not portable to
#     milliseconds;
#   - an identity file that is not one flat object, or holds non-ASCII.
_redlog_build_payload_fast() {
  local subtype="$1" command="$2" extra="$3" out="$4"
  # Bytewise. In a UTF-8 locale `[^ -~]` is a range of characters, and the
  # test means something else.
  local LC_ALL=C
  # `$5` is the adapter's identity, passed in so this builder and the python
  # one below are given the same answer by the same caller (#325). It resolves
  # its own when called without one, which is how shell-common.sh sourced on
  # its own — and the tests that do that — still record the running shell.
  local shell_name="${5:-}"
  if [[ -z "$shell_name" ]]; then
    _redlog_adapter_shell
    shell_name="$_redlog_shell"
  fi
  local tid="${REDLOG_TERMINAL_ID:-${_REDLOG_SESSION_ID:-}}"
  # Which WSL distro this shell is in. The renderer's connection check matches
  # on it, so two distros that both run bash cannot verify each other.
  local wsl="${WSL_DISTRO_NAME:-}"

  [[ "$subtype$command$shell_name$tid$wsl" == *[^\ -~]* ]] && return 1
  (( ${#command} + ${#extra} > 32768 )) && return 1
  [[ "$extra" == *[[:cntrl:]]* ]] && return 1

  # WHEN the command ran, not when someone next looked (Domain Invariant #8):
  # the same millisecond epoch the python builder takes with time.time().
  local now="${EPOCHREALTIME:-}" ms
  if [[ "$now" == [0-9]*.[0-9]* ]]; then
    local frac="${now#*.}"
    (( ${#frac} >= 3 )) || return 1
    ms="${now%.*}${frac:0:3}"
  else
    # No clock in the shell: bash before 5, which is what macOS ships. One
    # `date` is a fraction of the python3 this would otherwise hand over to,
    # with a temporary directory made and removed around it — three
    # processes and ~45 ms, twice a command. Only a `date` that prints
    # nanoseconds will do; one that prints a literal N (older BSD date) is
    # still the python builder's.
    now=$(date +%s%N 2>/dev/null)
    [[ -n "$now" && "$now" != *[!0-9]* && ${#now} -ge 16 ]] || return 1
    ms=${now:0:${#now}-6}
  fi

  local inner=""
  if [[ -n "$extra" ]]; then
    local t="${extra#"${extra%%[![:space:]]*}"}"
    t="${t%"${t##*[![:space:]]}"}"
    if [[ -n "$t" ]]; then
      [[ "$t" == \{*\} ]] || return 1
      inner="${t#\{}"
      inner="${inner#"${inner%%[![:space:]]*}"}"
      # `{}` has nothing to merge, and `,}` is not JSON.
      [[ "$inner" == "}" ]] && inner=""
    fi
  fi

  # Same file the python builder reads, and embedded under the same condition:
  # it names an engagement. Anything but one flat object goes to python.
  local ident="" idfile="${_REDLOG_DIR:-${HOME:-}/.redlog}/active-identity.json"
  if [[ -s "$idfile" ]]; then
    # In braces: a redirect on the assignment alone does not cover the shell's
    # own "permission denied" from `$(<file)`, which is the shell's message and
    # would land in the operator's terminal.
    { ident=$(<"$idfile"); } 2>/dev/null
    ident=${ident//$'\n'/}
    ident=${ident//$'\r'/}
    if [[ "$ident" == *'"engagementId"'* ]]; then
      local braces=${ident//[^\{\}]/}
      [[ "$ident" == \{*\} && "$braces" == '{}' ]] || return 1
      [[ "$ident" == *[^\ -~]* ]] && return 1
    else
      ident=""
    fi
  fi

  local body='{"agent_type":"shell","data":{"subtype":"'
  _redlog_json_quote "$subtype";    body+="$_redlog_json"'","command":"'
  _redlog_json_quote "$command";    body+="$_redlog_json"'","shell":"'
  _redlog_json_quote "$shell_name"; body+="$_redlog_json"'","pid":'"$$"',"source_timestamp":'"$ms"
  [[ "${REDLOG_TERMINAL:-}" == "1" ]] && body+=',"source":"builtin-terminal"'
  if [[ -n "$tid" ]]; then
    _redlog_json_quote "$tid"; body+=',"terminalId":"'"$_redlog_json"'"'
  fi
  if [[ -n "$wsl" ]]; then
    _redlog_json_quote "$wsl"; body+=',"wsl_distro":"'"$_redlog_json"'"'
  fi
  if [[ -n "$inner" ]]; then body+=",$inner"; else body+='}'; fi
  [[ -n "$ident" ]] && body+=',"_identity":'"$ident"
  body+='}'
  # Left in `_redlog_payload` as well: the sender passes no file and takes it
  # from there, so a delivered event needs no temporary file at all.
  _redlog_payload=$body
  [[ -z "$out" ]] || printf '%s' "$body" > "$out" 2>/dev/null
}

# curl with the bearer token supplied as a config, never as an argument (#489).
# $1 is the token; the rest are curl's arguments, and stdin goes to curl as it
# is, so the body can still be `--data-binary @-`.
#
# Where the shell has /dev/fd the config is a here-string on descriptor 4 and
# curl is given `-K /dev/fd/4`: no file is made and no process is started.
# Native Windows curl cannot open /dev/fd, so under Git Bash / Cygwin the
# config is a file beside the token file, named for this shell and given in
# Windows spelling (an MSYS path is what #345 was about), and emptied once
# curl has returned. Emptied, not removed: `rm` is a process, and under Git
# Bash a process is ~85 ms on the operator's prompt. The directory is the
# operator's own, as the token file's is.
_redlog_curl_authed() {
  local token="$1" conf
  shift
  token=${token//\\/\\\\}
  token=${token//\"/\\\"}
  conf="header = \"Authorization: Bearer $token\""
  case "${OSTYPE:-}" in
    cygwin*|msys*|win32*)
      local rc
      if [[ -z "${_REDLOG_CURL_CONF:-}" ]]; then
        # `pwd -W` is the Windows spelling of the directory: /tmp and /home are
        # mounts that native curl cannot resolve, and only the shell knows
        # where they point. One subshell, the first time.
        local dir="${_REDLOG_DIR:-${HOME:-}/.redlog}" win
        win=$(cd "$dir" 2>/dev/null && pwd -W 2>/dev/null) || win=$dir
        _REDLOG_CURL_CONF="$win/.curl-auth.$$"
      fi
      printf '%s\n' "$conf" > "$_REDLOG_CURL_CONF" || return 1
      curl -K "$_REDLOG_CURL_CONF" "$@"
      rc=$?
      : > "$_REDLOG_CURL_CONF"
      return $rc ;;
    *)
      curl -K /dev/fd/4 "$@" 4<<<"$conf" ;;
  esac
}

# POST one payload, read from stdin, to the running RedLog. stdin rather than
# `@file`: bash opens the file itself, so the path never reaches a native
# Windows curl, which cannot resolve an MSYS path like /tmp/x when
# MSYS_NO_PATHCONV=1 (or an MSYS2_ARG_CONV_EXCL covering "@") turns argument
# conversion off (#345). It stays out of argv, so the 128 KiB limit does not
# apply either.
#
# The bearer token does not travel in argv either: a process listing shows the
# argument vector of every process to every user on the host (#489). stdin is
# the body, so the token reaches curl as a config file (`_redlog_curl_authed`).
#
# The send is synchronous, on purpose: the notice at the next prompt reports
# what happened to the command that just ended (`_REDLOG_UNSAVED`), and a send
# in the background could only report it a prompt late. So what bounds the
# prompt is the deadline. A refused connection — RedLog not running — fails at
# once; a RedLog that accepts and never answers costs the whole deadline, on
# each of a command's two events. `$3` is that deadline: an event the shell
# built itself is at most a few KB, and gets 1 s; a body the python builder
# wrote, up to megabytes, keeps 2 s.
_redlog_post() {
  _redlog_curl_authed "$2" --noproxy '*' -sf -X POST "http://${_REDLOG_HOST}:$1/api/events" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    --connect-timeout 1 --max-time "${3:-2}" >/dev/null 2>&1
}

_redlog_send_event() {
  _redlog_terminal_allowed || return 0
  [[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0
  local subtype="$1" command="$2" extra="${3:-}"

  # Reachable means RedLog left its port and token where this hook looks. It
  # does not mean RedLog is up: it leaves both behind when it quits, so a closed
  # RedLog is normally a POST that fails below and is spooled. The other way to
  # arrive here is that those files are simply not there — never written,
  # deleted by a cleaner, a profile restored without them — and that must not
  # drop the command either (#315). Delivering needs the token; keeping a
  # command for replay does not, and PowerShell has always kept it.
  local reachable=0 port="" token=""
  if _redlog_is_running; then
    reachable=1
    _redlog_read_text "$_REDLOG_DIR/api-port"; port=$_redlog_text
    _redlog_read_text "$_REDLOG_DIR/api-token"; token=$_redlog_text
    _redlog_text=""
    if [[ -z "${_REDLOG_HOST:-}" ]]; then
      # Outside WSL the answer is 127.0.0.1 whatever the probe says, so the
      # probe — a curl, and the subshell around it — is only paid where there
      # is a gateway to choose between. Each is a process, and under Git Bash
      # starting one costs hundreds of milliseconds on the operator's prompt.
      if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
        _REDLOG_HOST=$(_redlog_resolve_host "$port")
      else
        _REDLOG_HOST=127.0.0.1
      fi
      export _REDLOG_HOST
    fi
  fi

  # Where the spool lives when nothing resolved it. Under WSL the directory
  # that RedLog drains is the Windows profile's, and that is only knowable from
  # the files this branch is missing — a guess at the Linux home would write
  # commands nobody ever replays, so there the command is left alone rather
  # than kept in the wrong place.
  local redlog_dir="${_REDLOG_DIR:-}"
  if [[ -z "$redlog_dir" ]]; then
    [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
    redlog_dir="$HOME/.redlog"
  fi

  # A built-in pane can remain alive at the project picker. Its activity is
  # deliberately unrecorded there, including the transport spool.
  [[ "${REDLOG_TERMINAL:-}" == "1" && ! -s "$redlog_dir/active-identity.json" ]] && return 0

  # The body never travels as an argument. One argument is capped at 128 KiB
  # by the kernel (MAX_ARG_STRLEN) and a command_end carries up to 8 MiB per
  # stream, so `python3 -c ... "$extra"` and `curl -d "$payload"` both failed
  # to exec for any command with a lot of output — and the failure was
  # swallowed, leaving no event and nothing in the spool. The fast builder
  # leaves it in a variable that reaches curl on stdin; the python builder
  # writes FILES in a work directory made only for it. `printf` and a
  # here-string are the shell's own and have no such limit, and neither starts
  # a process: under Git Bash `mktemp` and `rm` were most of a delivered
  # event's cost.
  local work="" payload="" payload_file=""

  # Most events are plain enough to be written without starting anything, and
  # starting python3 here was ~40 ms, twice per command (#288). When the shell
  # cannot be certain the result is the same JSON — a non-ASCII command, a
  # large body, an identity file it cannot read as one flat object — it says so
  # and this falls through to the builder below, which has always been the
  # reference. REDLOG_PAYLOAD_BUILDER=python forces it, for the test that holds
  # the two to the same output.

  # Which shell this event is, resolved once and given to BOTH builders, so
  # the fast path and the reference cannot record different shells for the
  # same event (#325).
  _redlog_adapter_shell
  local shell_name="$_redlog_shell"

  if [[ "${REDLOG_PAYLOAD_BUILDER:-}" != python ]] \
     && _redlog_build_payload_fast "$subtype" "$command" "$extra" "" "$shell_name"; then
    payload=$_redlog_payload
  else
  work=$(mktemp -d -t redlog-send.XXXXXX 2>/dev/null) || return 0
  payload_file="$work/payload.json"
  printf '%s' "$extra" > "$work/extra.json" 2>/dev/null || { rm -rf "$work"; return 0; }

  python3 -c "
import json, sys, os, pathlib, time
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        # Runtime identity is an argument, not interpolated login metadata.
        'shell': sys.argv[4],
        'pid': $$,
        # WHEN, not when someone next looked.
        #
        # A POST that fails spools the payload and RedLog replays it on the
        # next project open — so without this, a command run at 02:00 with
        # RedLog closed arrived claiming 09:00, the moment the operator opened
        # the project. A record whose times are the times someone read it is
        # not a record of the engagement (Domain Invariant #8).
        #
        # insertEvent validates the field and rejects anything before 2015 or
        # more than a minute ahead, with the rejection hashed into the row, so
        # a wrong unit is refused rather than silently believed.
        #
        # Nothing shell-special in these comments. The whole block is a
        # double-quoted shell string, so a backtick pair is command
        # substitution and a double quote ends the string: quoting a function
        # name the prose way ran it, and quoting the resulting error message
        # truncated the payload builder so that NO event was sent at all.
        'source_timestamp': int(time.time() * 1000)
    }
}
if os.environ.get('REDLOG_TERMINAL') == '1':
    d['data']['source'] = 'builtin-terminal'
tid = os.environ.get('REDLOG_TERMINAL_ID') or os.environ.get('_REDLOG_SESSION_ID')
if tid:
    d['data']['terminalId'] = tid
wsl = os.environ.get('WSL_DISTRO_NAME')
if wsl:
    d['data']['wsl_distro'] = wsl
extra = pathlib.Path(sys.argv[3]).read_text(encoding='utf-8', errors='replace')
if extra.strip():
    d['data'].update(json.loads(extra))
# Embed active project identity so spooled events can be attributed correctly.
try:
    identity_dir = pathlib.Path(os.environ.get('_REDLOG_DIR') or pathlib.Path.home().joinpath('.redlog'))
    ident = json.loads(identity_dir.joinpath('active-identity.json').read_text())
    if 'engagementId' in ident:
        d['_identity'] = ident
except Exception:
    pass
sys.stdout.write(json.dumps(d))
" "$subtype" "$command" "$work/extra.json" "$shell_name" > "$work/payload.json" 2>/dev/null \
    || { rm -rf "$work"; return 0; }
  fi

  # v0.6.87 A2: local spool for back-pressure. Previously curl was fire-and-
  # forget (`&`) with a 2s deadline — if RedLog was closed or the port was
  # unreachable the event silently vanished. Now: try curl inline; if it
  # fails, write the payload to a spool file that RedLog replays on next
  # project open. Spool cap: 5000 files (protects against a runaway loop
  # while RedLog is offline for weeks).
  local spool_dir="$redlog_dir/pending" delivered=0 post_rc=0
  # Foreground POST with short deadline; if it fails — or there was nowhere to
  # send it — spool. The directory and the file's name are made only then: two
  # processes on every event that is delivered, for a spool it never touches.
  if [[ "$reachable" == 1 ]]; then
    if [[ -n "$payload_file" ]]; then
      _redlog_post "$port" "$token" < "$payload_file" && delivered=1 || post_rc=$?
    else
      _redlog_post "$port" "$token" 1 <<<"$payload" && delivered=1 || post_rc=$?
    fi
  fi
  [[ "$delivered" == 1 ]] && _REDLOG_UNSAVED=""
  if [[ "$delivered" != 1 ]]; then
    # Cap spool at 5000 entries — beyond that we accept loss over disk fill.
    #
    # Only the files still waiting for replay. Replay renames what it cannot
    # attribute to `*.json.unattributed` and keeps it (#255), so counting the
    # whole directory let a pile of those fill the cap and silently stop every
    # new event from being spooled. Counted by `_redlog_count_waiting`.
    #
    # And only while a project identity exists. Replay never claims a file that
    # carries no engagementId — it sets it aside as `*.unattributed` and keeps
    # it forever (#255) — so spooling without one only builds a pile nothing
    # reads. RedLog removes active-identity.json when the project closes, which
    # makes "no identity" the same thing as "no project to record into".
    # The test is grep's, `grep -qs '"engagementId"'`, made by `read` rather
    # than a process.
    if ! { _redlog_read_text "${_REDLOG_DIR:-${HOME:-}/.redlog}/active-identity.json" \
           && [[ "$_redlog_text" == *'"engagementId"'* ]]; }; then
      # Dropped, and the operator has not been told. The next prompt says so
      # (`_redlog_warn_unsaved`), from this outcome: no extra request per
      # prompt. `curl -f` exits 22 for an HTTP error, so RedLog answered; with
      # no identity that is the 503 it gives while no project is open.
      if [[ "${_REDLOG_UNSAVED:-}" != told ]]; then
        if [[ "$post_rc" == 22 ]]; then _REDLOG_UNSAVED=no-project; else _REDLOG_UNSAVED=unreachable; fi
      fi
      [[ -z "$work" ]] || rm -rf "$work"
      return 0
    fi
    _redlog_text=""
    # `mkdir -p` leaves an existing directory and its mode alone, so only a
    # missing one needs the process.
    [[ -d "$spool_dir" ]] || mkdir -m 700 -p "$spool_dir" 2>/dev/null
    local spool_file
    _redlog_count_waiting "$spool_dir"
    if [[ "$_redlog_count" -lt 5000 ]]; then
      _REDLOG_UNSAVED=""
      if [[ -n "$work" ]]; then
        # The work directory is already unique, including on BSD date where
        # %N is literal and several events share one second and shell PID.
        _redlog_ns_stamp
        spool_file="$spool_dir/$_redlog_ns.$$.${work##*/}.json"
        chmod 600 "$payload_file" 2>/dev/null
        mv "$payload_file" "$spool_file" 2>/dev/null
      else
        # No work directory to borrow a unique name from. noclobber makes the
        # write fail rather than overwrite a name another event took, and it
        # is written beside the spool under a name replay does not read, then
        # renamed in whole: replay never sees half a file.
        local try
        for try in 1 2 3 4 5; do
          _redlog_ns_stamp
          spool_file="$spool_dir/$_redlog_ns.$$.redlog-send.${RANDOM}${RANDOM}.json"
          if ( umask 077; set -C; printf '%s' "$payload" > "$spool_file.tmp" ) 2>/dev/null; then
            mv "$spool_file.tmp" "$spool_file" 2>/dev/null
            break
          fi
        done
      fi
    fi
  fi
  [[ -z "$work" ]] || rm -rf "$work"
}

# True only for something the relay can actually launch as a process. A path
# is taken at its word; a bare name must resolve to an absolute path, which
# `command -v` gives for an external command and not for a builtin, function,
# keyword or alias — in both bash and zsh.
_redlog_is_external() {
  case "$1" in
    */*) [[ -x "$1" ]] ;;
    *)
      local resolved
      resolved=$(command -v -- "$1" 2>/dev/null) || return 1
      [[ "$resolved" == /* ]]
      ;;
  esac
}

# --- Opt-in structured capture wrapper ---
# Usage: redlog-run <command> [args...]
# Runs the given command with stdout and stderr streamed through separate
# tee processes into temp files. The terminal receives bytes while the command
# is still running; command_end carries the existing capped structured fields.
#
# The normal preexec/precmd hooks will ALSO fire for the `redlog-run`
# invocation itself. That's fine — the wrapper's command_end lands after
# with the structured fields; the plain one just has metadata.
# 8 MiB per stream, and the number means something different than it used to.
#
# 100 KB was chosen for a wrapper used on purpose a few times per engagement.
# Once every command is relayed, `nmap -A`, `ffuf` and `gobuster` hit that
# routinely, and a truncated scan is the evidence the operator most wanted.
# The answer is not a bigger truncation limit: RedLog externalises anything
# over its inline threshold to the project's body store on receipt, the way it
# already does for HTTP bodies, so a large body is kept in full and the event
# carries a reference (research.md T006).
#
# What remains here is a MEMORY bound on the relay — two of these are resident
# while a command runs — so a runaway `yes` is stopped rather than growing
# until something else fails. When it fires the event says `truncated` and
# names the bound (FR-004); it is not a silent cut.
#
# Overridable so a test can hit the bound without producing 8 MiB, and so an
# operator who knows what they are running can move it.
_REDLOG_MAX_BYTES=${REDLOG_MAX_BYTES:-8388608}
redlog-run() {
  if [[ $# -eq 0 ]]; then
    printf 'redlog-run: expected a command\n' >&2
    return 2
  fi
  # If RedLog isn't reachable, just run the command transparently — the
  # hook is dormant, so a wrapper that fails would just annoy the user.
  if ! _redlog_terminal_allowed || ! _redlog_is_running; then
    command "$@"
    return $?
  fi

  local cmd_string="$*"
  local start_ts=${EPOCHSECONDS:-$(date +%s)}
  local command_id
  command_id=$(_redlog_new_command_id)

  # Emit command_start so the timeline shows the row entering flight.
  _redlog_send_event "command_start" "$cmd_string" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"captured_by\":\"redlog-run\",\"command_id\":\"$command_id\"}"

  # A builtin, function or keyword has to run in THIS shell or it does
  # nothing: `redlog-run cd /tmp` through a relay would change a directory
  # that exits a millisecond later. It runs where it always did, and the
  # record says plainly that there is no body and why — `not-captured`,
  # `metadata-only`, the vocabulary contracts/events.md already defines for a
  # command whose output the relay never held.
  if ! _redlog_is_external "$1"; then
    command "$@"
    local builtin_code=$?
    local builtin_duration=$(( ${EPOCHSECONDS:-$(date +%s)} - start_ts ))
    _redlog_send_event "command_end" "$cmd_string" \
      "{\"exit_code\":$builtin_code,\"duration_sec\":$builtin_duration,\"cwd\":\"${PWD//\"/\\\"}\",\"captured_by\":\"redlog-run\",\"command_id\":\"$command_id\",\"completeness\":\"metadata-only\",\"output_disposition\":\"not-captured\"}"
    return $builtin_code
  fi

  local event_file
  event_file=$(mktemp -t redlog-event.XXXXXX) || { command "$@"; return $?; }

  # The descriptors, the cap and the event JSON belong to the relay — see
  # hooks/redlog-relay.py. This was two named pipes, two `tee`s and an inline
  # python heredoc right here; spec 052 needs the same capture from preexec
  # for every command, and two of them would drift (research.md D2).
  python3 "$_REDLOG_RELAY" run \
    --event-out "$event_file" \
    --max-bytes "$_REDLOG_MAX_BYTES" \
    --cwd "$PWD" \
    --captured-by redlog-run \
    --command-id "$command_id" \
    -- "$@"
  local exit_code=$?

  if [[ ! -e "$event_file.started" ]]; then
    # The relay never reached the command: no python3, no relay file, an
    # unwritable temp dir. The command has NOT run — the same fall-through
    # this wrapper has always had when `mkfifo` failed. Unrecorded is bad;
    # not run at all is worse.
    rm -f "$event_file"
    command "$@"
    return $?
  fi

  local extra
  extra=$(cat "$event_file" 2>/dev/null)
  if [[ -z "$extra" ]]; then
    # The relay ran the command but could not write the event — fall back to
    # bare metadata so the row still lands with the right exit code.
    local duration=$(( ${EPOCHSECONDS:-$(date +%s)} - start_ts ))
    extra="{\"exit_code\":$exit_code,\"duration_sec\":$duration,\"cwd\":\"${PWD//\"/\\\"}\",\"captured_by\":\"redlog-run\",\"command_id\":\"$command_id\",\"completeness\":\"metadata-only\",\"output_disposition\":\"not-captured\"}"
  fi

  _redlog_send_event "command_end" "$cmd_string" "$extra"

  rm -f "$event_file" "$event_file.started"
  return $exit_code
}

# FR-009, said at the prompt by both adapters. The commands run either way —
# that part has always worked, silently, and silence is the bug. An operator
# whose RedLog crashed two hours ago has been working unrecorded with no way to
# know.
#
# Once, though, and only on the way in. A warning on every prompt is one an
# operator learns to read past, and then the one that matters is read past too.
# The flags are shell variables on purpose: "have I said this in this shell" is
# not state that should survive a subshell, unlike the stop (FR-022).
#
# Two ways in. Without the port and token files there is nothing to send to,
# which is checked only after a command (`$1` is 1). With them — and RedLog
# leaves them behind when it quits — the send itself is the evidence: an event
# that was neither delivered nor spooled left `_REDLOG_UNSAVED` set. A
# delivered or spooled event clears it, so the next loss is said again. A
# terminal stopped with `redlog stop`, or not selected for recording, is not
# losing anything it was asked to keep, and is not told it is.
#
# Called once per prompt by both adapters, and the adoption notice goes with
# it, last: a drop said here happened before the project opened.
_redlog_warn_unsaved() {
  _redlog_warn_dropped "$@"
  _redlog_announce_adoption
  return 0
}

# The other half of "no project is open … not being recorded": a terminal that
# loaded with no project open records into the first one RedLog opens after
# it, and says so once, with the project's name. The identity file carries
# only ids; the name is in RedLog's local project index, read once here rather
# than asked of RedLog. A shell that loaded with a project open, a built-in
# pane (RedLog enrolls those itself) and a stopped terminal say nothing.
_redlog_announce_adoption() {
  [[ "${REDLOG_TERMINAL:-}" == "1" ]] && return 0
  # A project opened while a command ran is first seen here; one opened while
  # the prompt waited, by the check before the next command.
  [[ -n "${_REDLOG_IDENTITY_SEEN:-}" ]] || _redlog_check_project
  [[ -n "${_REDLOG_ADOPTED:-}" ]] || return 0
  _REDLOG_ADOPTED=""
  _redlog_is_recording || return 0
  local ident label
  ident=$(_redlog_identity_file)
  label=$(python3 -c '
import json, sys
try:
    eid = str(json.load(open(sys.argv[1])).get("engagementId") or "")
except Exception:
    sys.exit(0)
name = ""
try:
    for p in json.load(open(sys.argv[2])).get("recent") or []:
        if isinstance(p, dict) and p.get("id") == eid:
            name = str(p.get("name") or "")
            break
except Exception:
    pass
name = " ".join("".join(c if c.isprintable() else " " for c in name).split())
sys.stdout.write(name or eid)
' "$ident" "${ident%/*}/projects.json" 2>/dev/null)
  if [[ -z "$label" ]]; then
    { label=$(<"$ident"); } 2>/dev/null
    label=${label#*\"engagementId\":}
    label=${label#"${label%%[![:space:]]*}"}
    case "$label" in
      \"*) label=${label#\"}; label=${label%%\"*} ;;
      *) return 0 ;;
    esac
  fi
  printf '%s\n' "[redlog] project \"$label\" is open in RedLog; this terminal is now being recorded into it" >&2
}

_redlog_warn_dropped() {
  if [[ "${1:-}" == 1 ]]; then
    if _redlog_is_running; then
      _REDLOG_WARNED_UNREACHABLE=""
    else
      if [[ -z "${_REDLOG_WARNED_UNREACHABLE:-}" ]]; then
        _REDLOG_WARNED_UNREACHABLE=1
        # The text of each command is still kept for replay (#315) — the sender
        # spools it with nowhere to send it — but not what it printed, which
        # only a live relay can hold. Saying "unrecorded" would mislead too.
        if [[ ! -s "$(_redlog_identity_file)" ]]; then
          printf '%s\n' "[redlog] RedLog is not reachable — no project is open; commands and output are not being saved" >&2
        else
          printf '%s\n' "[redlog] RedLog is not reachable — commands are running without live recording; their text is kept for replay, their output is not" >&2
        fi
      fi
      # Whatever was dropped meanwhile is the loss that line describes.
      [[ -z "${_REDLOG_UNSAVED:-}" ]] || _REDLOG_UNSAVED=told
      return 0
    fi
  fi
  case "${_REDLOG_UNSAVED:-}" in
    unreachable|no-project) ;;
    *) return 0 ;;
  esac
  if ! _redlog_is_recording; then
    _REDLOG_UNSAVED=""
    return 0
  fi
  if [[ "$_REDLOG_UNSAVED" == no-project ]]; then
    printf '%s\n' "[redlog] no project is open in RedLog; this terminal is not being recorded" >&2
  else
    printf '%s\n' "[redlog] RedLog is not reachable; this terminal is not being recorded" >&2
  fi
  _REDLOG_UNSAVED=told
  return 0
}

# Loading the adapter is not proof of recording or delivery. The terminal's
# explicit status names its project and switch; startup must not promise output.
_redlog_announce_shell() {
  local where=""
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && where=" (WSL: ${WSL_DISTRO_NAME})"
  echo "[redlog] shell hook loaded${where}"
  # Said at startup because it is the one thing an operator cannot discover by
  # looking: everything else about this adapter is visible in the timeline.
  if [[ "${_REDLOG_ADAPTER_SHELL:-}" == "zsh" || "${_REDLOG_ADAPTER_SHELL:-}" == "bash" ]]; then
    echo "[redlog] redlog status  ·  redlog stop"
  fi
}
