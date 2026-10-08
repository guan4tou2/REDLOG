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
    echo "$HOME/.redlog"
    return
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

_redlog_send_event() {
  [[ "${REDLOG_EXTERNAL_SESSION:-}" == "1" ]] && return 0
  local subtype="$1" command="$2" extra="${3:-}"
  _redlog_is_running || return 0

  local port=$(<"$_REDLOG_DIR/api-port")
  local token=$(<"$_REDLOG_DIR/api-token")

  if [[ -z "${_REDLOG_HOST:-}" ]]; then
    _REDLOG_HOST=$(_redlog_resolve_host "$port")
    export _REDLOG_HOST
  fi

  local payload
  payload=$(python3 -c "
import json, sys, os, pathlib, time
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': '${SHELL##*/}',
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
if sys.argv[3]:
    d['data'].update(json.loads(sys.argv[3]))
# Embed active project identity so spooled events can be attributed correctly.
try:
    ident = json.loads(pathlib.Path.home().joinpath('.redlog', 'active-identity.json').read_text())
    if 'engagementId' in ident:
        d['_identity'] = ident
except Exception:
    pass
print(json.dumps(d))
" "$subtype" "$command" "$extra" 2>/dev/null) || return 0

  # v0.6.87 A2: local spool for back-pressure. Previously curl was fire-and-
  # forget (`&`) with a 2s deadline — if RedLog was closed or the port was
  # unreachable the event silently vanished. Now: try curl inline; if it
  # fails, write the payload to a spool file that RedLog replays on next
  # project open. Spool cap: 5000 files (protects against a runaway loop
  # while RedLog is offline for weeks).
  local spool_dir="$_REDLOG_DIR/pending"
  mkdir -p "$spool_dir" 2>/dev/null
  local spool_file="$spool_dir/$(date +%s%N).$$.json"
  # Foreground POST with short deadline; if it fails, spool.
  if ! curl --noproxy '*' -sf -X POST "http://${_REDLOG_HOST}:${port}/api/events" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --connect-timeout 1 --max-time 2 >/dev/null 2>&1; then
    # Cap spool at 5000 entries — beyond that we accept loss over disk fill.
    local count
    count=$(ls -1 "$spool_dir" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$count" -lt 5000 ]]; then
      printf '%s' "$payload" > "$spool_file" 2>/dev/null
    fi
  fi
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

# What this shell is actually doing, in the words that are true of it.
#
# It said "command metadata will be logged" and offered `redlog-run` as the way
# to get output. Both stopped being true when the zsh adapter started relaying
# output on its own (spec 052 T020), and a banner that overstates what is
# recorded is worse than no banner: an operator who believes the output is in
# the record stops checking.
#
# `$1` is what the adapter records without being asked — "commands" for the
# bash adapter, "commands and their output" for zsh.
_redlog_announce_shell() {
  local what="${1:-commands}"
  local where=""
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && where=" (WSL: ${WSL_DISTRO_NAME})"
  echo "[redlog] shell hook active${where} — ${what} will be recorded"
  # Said at startup because it is the one thing an operator cannot discover by
  # looking: everything else about this adapter is visible in the timeline.
  echo "[redlog] redlog status  ·  redlog stop"
}
