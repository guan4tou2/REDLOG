#!/usr/bin/env bash
# Shared RedLog POSIX shell transport and explicit output-capture wrapper.
# Lifecycle integration belongs in shell-bash-hook.sh / shell-zsh-hook.zsh.
# This file is sourced by an adapter; do not source it directly.

_REDLOG_LAST_CMD=""
_REDLOG_CMD_START=""

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
_redlog_resolve_host() {
  local port="$1"
  if curl -sf --connect-timeout 1 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "127.0.0.1"
    return
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    local gw
    gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
    if [[ -n "$gw" ]] && curl -sf --connect-timeout 1 "http://${gw}:${port}/api/health" >/dev/null 2>&1; then
      echo "$gw"
      return
    fi
  fi
  echo "127.0.0.1"
}

_redlog_is_running() {
  [[ -n "${_REDLOG_DIR:-}" ]] || { _REDLOG_DIR=$(_redlog_resolve_dir) || return 1; export _REDLOG_DIR; }
  [[ -f "$_REDLOG_DIR/api-port" ]] && [[ -f "$_REDLOG_DIR/api-token" ]]
}

_redlog_send_event() {
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
import json, sys, os, pathlib
d = {
    'agent_type': 'shell',
    'data': {
        'subtype': sys.argv[1],
        'command': sys.argv[2],
        'shell': '${SHELL##*/}',
        'pid': $$
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
  if ! curl -sf -X POST "http://${_REDLOG_HOST}:${port}/api/events" \
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

# --- Opt-in structured capture wrapper ---
# Usage: redlog-run <command> [args...]
# Runs the given command with stdout and stderr streamed through separate
# tee processes into temp files. The terminal receives bytes while the command
# is still running; command_end carries the existing capped structured fields.
#
# The normal preexec/precmd hooks will ALSO fire for the `redlog-run`
# invocation itself. That's fine — the wrapper's command_end lands after
# with the structured fields; the plain one just has metadata.
_REDLOG_MAX_BYTES=102400  # 100 KB per stream
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
  local stdout_file stderr_file pipe_dir stdout_pipe stderr_pipe
  stdout_file=$(mktemp -t redlog-stdout.XXXXXX) || { command "$@"; return $?; }
  stderr_file=$(mktemp -t redlog-stderr.XXXXXX) || { rm -f "$stdout_file"; command "$@"; return $?; }
  pipe_dir=$(mktemp -d -t redlog-stream.XXXXXX) || {
    rm -f "$stdout_file" "$stderr_file"
    command "$@"
    return $?
  }
  stdout_pipe="$pipe_dir/stdout"
  stderr_pipe="$pipe_dir/stderr"
  if ! mkfifo "$stdout_pipe" "$stderr_pipe"; then
    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$pipe_dir"
    command "$@"
    return $?
  fi

  # Emit command_start so the timeline shows the row entering flight.
  _redlog_send_event "command_start" "$cmd_string" \
    "{\"cwd\":\"${PWD//\"/\\\"}\",\"captured_by\":\"redlog-run\"}"

  # Stream each descriptor back to the same terminal descriptor while teeing
  # the bytes to disk. Named pipes let us wait for both tee processes before
  # reading the files, avoiding a race at command exit.
  tee "$stdout_file" <"$stdout_pipe" &
  local stdout_tee_pid=$!
  tee "$stderr_file" <"$stderr_pipe" >&2 &
  local stderr_tee_pid=$!
  command "$@" 1>"$stdout_pipe" 2>"$stderr_pipe"
  local exit_code=$?
  wait "$stdout_tee_pid" 2>/dev/null || true
  wait "$stderr_tee_pid" 2>/dev/null || true
  local end_ts=${EPOCHSECONDS:-$(date +%s)}
  local duration=$(( end_ts - start_ts ))

  # Byte counts (before any truncation).
  local stdout_bytes stderr_bytes
  stdout_bytes=$(wc -c <"$stdout_file" 2>/dev/null | tr -d ' ')
  stderr_bytes=$(wc -c <"$stderr_file" 2>/dev/null | tr -d ' ')
  stdout_bytes=${stdout_bytes:-0}
  stderr_bytes=${stderr_bytes:-0}

  # Build the event JSON in python. Python reads the temp files DIRECTLY —
  # this avoids every quoting/argv-size/binary hazard of stuffing 100 KB
  # of arbitrary bytes through bash argv. Invalid UTF-8 is replaced with
  # U+FFFD so the JSON encoder never explodes on binary output.
  local extra
  extra=$(REDLOG_STDOUT_FILE="$stdout_file" \
          REDLOG_STDERR_FILE="$stderr_file" \
          REDLOG_EXIT_CODE="$exit_code" \
          REDLOG_DURATION_SEC="$duration" \
          REDLOG_STDOUT_BYTES="$stdout_bytes" \
          REDLOG_STDERR_BYTES="$stderr_bytes" \
          REDLOG_MAX_BYTES="$_REDLOG_MAX_BYTES" \
          REDLOG_CWD="$PWD" \
          python3 -c '
import json, os
CAP = int(os.environ.get("REDLOG_MAX_BYTES", "102400"))

def read_capped(path):
    try:
        with open(path, "rb") as f:
            raw = f.read(CAP + 1)
    except OSError:
        return "", False
    truncated = len(raw) > CAP
    if truncated:
        raw = raw[:CAP]
    return raw.decode("utf-8", errors="replace"), truncated

so, so_t = read_capped(os.environ["REDLOG_STDOUT_FILE"])
se, se_t = read_capped(os.environ["REDLOG_STDERR_FILE"])
print(json.dumps({
    "exit_code": int(os.environ.get("REDLOG_EXIT_CODE", "0")),
    "duration_sec": int(os.environ.get("REDLOG_DURATION_SEC", "0")),
    "cwd": os.environ.get("REDLOG_CWD", ""),
    "stdout": so,
    "stderr": se,
    "stdout_bytes": int(os.environ.get("REDLOG_STDOUT_BYTES", "0")),
    "stderr_bytes": int(os.environ.get("REDLOG_STDERR_BYTES", "0")),
    "stdout_truncated": so_t,
    "stderr_truncated": se_t,
    "captured_by": "redlog-run"
}))
' 2>/dev/null) || extra=""

  if [[ -z "$extra" ]]; then
    # Python failed for some reason — fall back to bare metadata so the
    # event still lands with the right exit code.
    extra="{\"exit_code\":$exit_code,\"duration_sec\":$duration,\"cwd\":\"${PWD//\"/\\\"}\",\"captured_by\":\"redlog-run\"}"
  fi

  _redlog_send_event "command_end" "$cmd_string" "$extra"

  rm -f "$stdout_file" "$stderr_file"
  rm -rf "$pipe_dir"
  return $exit_code
}

_redlog_announce_shell() {
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    echo "[redlog] shell hook active (WSL: ${WSL_DISTRO_NAME}) — command metadata will be logged to RedLog timeline"
  else
    echo "[redlog] shell hook active — command metadata will be logged to RedLog timeline"
  fi
  echo "[redlog] tip: prefix a command with 'redlog-run' to stream and capture stdout/stderr"
}
