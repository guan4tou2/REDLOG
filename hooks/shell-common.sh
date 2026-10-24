#!/usr/bin/env bash
# Shared RedLog POSIX shell transport and explicit output-capture wrapper.
# Lifecycle integration belongs in shell-bash-hook.sh / shell-zsh-hook.zsh.
# This file is sourced by an adapter; do not source it directly.

_REDLOG_LAST_CMD=""
_REDLOG_CMD_START=""
_REDLOG_SESSION_HELPER="${_redlog_adapter_dir:-}/redlog-session.py"
_REDLOG_RELAY="${_redlog_adapter_dir:-}/redlog-relay.py"

redlog-session() {
  python3 "$_REDLOG_SESSION_HELPER" "$@"
}


# --- Resolve RedLog dir (token + port files) ---
# Native: $HOME/.redlog; WSL: auto-resolve from Windows %USERPROFILE%
_redlog_resolve_dir() {
  if [[ -f "$HOME/.redlog/api-token" ]]; then
    # Under WSL a native directory may be stale. Adopt it only while its
    # API answers; otherwise resolve the Windows profile below (#326).
    if [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
      echo "$HOME/.redlog"
      return
    fi
    local native_port=""
    [[ -f "$HOME/.redlog/api-port" ]] && native_port=$(<"$HOME/.redlog/api-port")
    case "$native_port" in
      ''|*[!0-9]*) ;;
      *) if curl --noproxy '*' -sf --connect-timeout 1 --max-time 2 \
          "http://127.0.0.1:${native_port}/api/health" >/dev/null 2>&1; then
        echo "$HOME/.redlog"
        return
      fi ;;
    esac
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
  local stamp
  stamp=$(date +%s%N 2>/dev/null)
  case "$stamp" in
    ''|*N*) stamp="$(date +%s)${RANDOM:-0}" ;;
  esac
  printf '%s-%s-%s' "$stamp" "$$" "${RANDOM:-0}"
}

# Where the active project's identity lives. Paths into the RedLog directory
# belong here rather than in an adapter: `shell-adapter-boundaries.test.ts`
# holds that line, and it is the reason every POSIX adapter emits the same
# contract instead of each one knowing its own layout.
_redlog_identity_file() {
  printf '%s/active-identity.json' "${_REDLOG_DIR:-$HOME/.redlog}"
}

_redlog_is_running() {
  [[ -n "${_REDLOG_DIR:-}" ]] || { _REDLOG_DIR=$(_redlog_resolve_dir) || return 1; export _REDLOG_DIR; }
  [[ -f "$_REDLOG_DIR/api-port" ]] && [[ -f "$_REDLOG_DIR/api-token" ]]
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
  local tid="${REDLOG_TERMINAL_ID:-}"
  # Which WSL distro this shell is in. The renderer's connection check matches
  # on it, so two distros that both run bash cannot verify each other.
  local wsl="${WSL_DISTRO_NAME:-}"

  [[ "$subtype$command$shell_name$tid$wsl" == *[^\ -~]* ]] && return 1
  (( ${#command} + ${#extra} > 32768 )) && return 1
  [[ "$extra" == *[[:cntrl:]]* ]] && return 1

  # WHEN the command ran, not when someone next looked (Domain Invariant #8):
  # the same millisecond epoch the python builder takes with time.time().
  local now="${EPOCHREALTIME:-}"
  [[ "$now" == [0-9]*.[0-9]* ]] || return 1
  local frac="${now#*.}"
  (( ${#frac} >= 3 )) || return 1
  local ms="${now%.*}${frac:0:3}"

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
  printf '%s' "$body" > "$out" 2>/dev/null
}

_redlog_send_event() {
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
    port=$(<"$_REDLOG_DIR/api-port")
    token=$(<"$_REDLOG_DIR/api-token")
    if [[ -z "${_REDLOG_HOST:-}" ]]; then
      _REDLOG_HOST=$(_redlog_resolve_host "$port")
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

  # The body travels in FILES, never as an argument. One argument is capped at
  # 128 KiB by the kernel (MAX_ARG_STRLEN) and a command_end carries up to
  # 8 MiB per stream, so `python3 -c ... "$extra"` and `curl -d "$payload"`
  # both failed to exec for any command with a lot of output — and the failure
  # was swallowed, leaving no event and nothing in the spool. `printf` is a
  # builtin and has no such limit.
  local work
  work=$(mktemp -d -t redlog-send.XXXXXX 2>/dev/null) || return 0

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
     && _redlog_build_payload_fast "$subtype" "$command" "$extra" "$work/payload.json" "$shell_name"; then
    :
  else
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
tid = os.environ.get('REDLOG_TERMINAL_ID')
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
  local spool_dir="$redlog_dir/pending"
  # Foreground POST with short deadline; if it fails — or there was nowhere to
  # send it — spool. The directory and the file's name are made only then: two
  # processes on every event that is delivered, for a spool it never touches.
  if [[ "$reachable" != 1 ]] || ! curl --noproxy '*' -sf -X POST "http://${_REDLOG_HOST}:${port}/api/events" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        --data-binary @"$work/payload.json" \
        --connect-timeout 1 --max-time 2 >/dev/null 2>&1; then
    # Cap spool at 5000 entries — beyond that we accept loss over disk fill.
    #
    # Only the files still waiting for replay. Replay renames what it cannot
    # attribute to `*.json.unattributed` and keeps it (#255), so counting the
    # whole directory let a pile of those fill the cap and silently stop every
    # new event from being spooled. `find`, not a glob: an unmatched glob is an
    # error zsh prints itself, whatever the command's own stderr is sent to.
    #
    # And only while a project identity exists. Replay never claims a file that
    # carries no engagementId — it sets it aside as `*.unattributed` and keeps
    # it forever (#255) — so spooling without one only builds a pile nothing
    # reads. RedLog removes active-identity.json when the project closes, which
    # makes "no identity" the same thing as "no project to record into".
    if ! grep -qs '"engagementId"' "${_REDLOG_DIR:-${HOME:-}/.redlog}/active-identity.json" 2>/dev/null; then
      rm -rf "$work"
      return 0
    fi
    mkdir -p "$spool_dir" 2>/dev/null
    local count spool_file
    count=$(find "$spool_dir" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$count" -lt 5000 ]]; then
      # The work directory is already unique, including on BSD date where
      # %N is literal and several events share one second and shell PID.
      spool_file="$spool_dir/$(date +%s%N).$$.${work##*/}.json"
      mv "$work/payload.json" "$spool_file" 2>/dev/null
    fi
  fi
  rm -rf "$work"
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
  if ! _redlog_is_running; then
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
