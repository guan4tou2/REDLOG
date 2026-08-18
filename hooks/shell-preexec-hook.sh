#!/usr/bin/env bash
# RedLog Shell Preexec Hook
# Captures every command executed in the terminal and sends to RedLog.
# Works with ANY agent that spawns a shell (Claude Code, Codex, GPT, Cursor, etc.)
#
# Usage — add to your ~/.zshrc or ~/.bashrc:
#   source /path/to/redlog/hooks/shell-preexec-hook.sh
#
# This hooks into:
#   - zsh:  preexec / precmd
#   - bash: DEBUG trap + PROMPT_COMMAND
#
# For STRUCTURED stdout/stderr capture (v0.6.89+), prefix a command with
# `redlog-run`, e.g.:
#   redlog-run nmap -sV target.com
# The default preexec/precmd hooks only report command metadata (exit code,
# duration, cwd) — POSIX shells can't cleanly split stdout/stderr from a
# preexec hook. `redlog-run` runs the command with the two streams captured
# into separate files, truncated at 100 KB each, and sends them alongside
# the standard command_end event. Binary output (e.g. hexdump) renders as
# UTF-8 replacement characters; base64 mode is TODO.

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
import json, sys, os
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

# --- Zsh hooks ---
if [[ -n "${ZSH_VERSION:-}" ]]; then
  _redlog_preexec() {
    _REDLOG_LAST_CMD="$1"
    _REDLOG_CMD_START=$EPOCHSECONDS
    _redlog_send_event "command_start" "$1"
  }

  _redlog_precmd() {
    local exit_code=$?
    if [[ -n "$_REDLOG_LAST_CMD" ]]; then
      local duration=""
      if [[ -n "$_REDLOG_CMD_START" ]]; then
        duration=$(( EPOCHSECONDS - _REDLOG_CMD_START ))
      fi
      _redlog_send_event "command_end" "$_REDLOG_LAST_CMD" \
        "{\"exit_code\":$exit_code,\"duration_sec\":${duration:-0},\"cwd\":\"${PWD//\"/\\\"}\"}"
      _REDLOG_LAST_CMD=""
      _REDLOG_CMD_START=""
    fi
  }

  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _redlog_preexec
  add-zsh-hook precmd _redlog_precmd

# --- Bash hooks ---
elif [[ -n "${BASH_VERSION:-}" ]]; then
  _REDLOG_SOURCING=1

  _redlog_debug_trap() {
    [[ -n "${_REDLOG_SOURCING:-}" ]] && return
    [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
    [[ -n "$_REDLOG_LAST_CMD" ]] && return
    _REDLOG_LAST_CMD="$BASH_COMMAND"
    _REDLOG_CMD_START=$SECONDS
    _redlog_send_event "command_start" "$BASH_COMMAND"
  }

  _redlog_prompt_command() {
    local exit_code=$?
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
fi

# --- Opt-in structured capture wrapper ---
# Usage: redlog-run <command> [args...]
# Runs the given command with stdout and stderr captured into separate
# temp files (each truncated at 100 KB), sends command_start / command_end
# with the structured `stdout` / `stderr` / `*_bytes` / `*_truncated`
# fields, and passes the output through to the user's terminal so nothing
# looks different from running the command bare.
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
  local stdout_file stderr_file
  stdout_file=$(mktemp -t redlog-stdout.XXXXXX) || { command "$@"; return $?; }
  stderr_file=$(mktemp -t redlog-stderr.XXXXXX) || { rm -f "$stdout_file"; command "$@"; return $?; }

  # Emit command_start so the timeline shows the row entering flight.
  _redlog_send_event "command_start" "$cmd_string"

  # Run the command with stream splitting. Use `command` to avoid infinite
  # recursion if a user aliases the target name back to redlog-run.
  command "$@" 1>"$stdout_file" 2>"$stderr_file"
  local exit_code=$?
  local end_ts=${EPOCHSECONDS:-$(date +%s)}
  local duration=$(( end_ts - start_ts ))

  # Byte counts (before any truncation).
  local stdout_bytes stderr_bytes
  stdout_bytes=$(wc -c <"$stdout_file" 2>/dev/null | tr -d ' ')
  stderr_bytes=$(wc -c <"$stderr_file" 2>/dev/null | tr -d ' ')
  stdout_bytes=${stdout_bytes:-0}
  stderr_bytes=${stderr_bytes:-0}

  # Pass output through to the user's terminal (before we build/send the
  # event) so the shell feels normal even if the send is slow.
  cat "$stdout_file"
  cat "$stderr_file" >&2

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
  return $exit_code
}

if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  echo "[redlog] shell hook active (WSL: ${WSL_DISTRO_NAME}) — commands will be logged to RedLog timeline"
else
  echo "[redlog] shell hook active — commands will be logged to RedLog timeline"
fi

unset _REDLOG_SOURCING
