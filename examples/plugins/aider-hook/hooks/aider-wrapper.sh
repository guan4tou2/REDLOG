#!/usr/bin/env bash
# RedLog × Aider Shell Wrapper (Tier B)
#
# Aider (https://aider.chat) has no dedicated hook API. On the pexpect (TTY)
# code path in aider/run_cmd.py it invokes the shell resolved from
# `os.environ["SHELL"]` (default `/bin/sh`) as:
#
#     $SHELL -i -c '<command>'
#
# Setting SHELL to the absolute path of this script routes every such call
# through here, so we can bracket the command with command_start / command_end
# events on RedLog's timeline before handing the actual work off to a real
# shell.
#
# LIMITATIONS:
#   * Non-TTY Aider runs and the Windows code path fall back to
#     subprocess.Popen(cmd, shell=True), which on POSIX ALWAYS uses `/bin/sh`
#     regardless of $SHELL. Those commands cannot be captured this way.
#   * There is no upstream `AIDER_SHELL` / `AIDER_SHELL_CMD` env var; the
#     underlying request (Aider issues #1215, #1337) is unimplemented. If
#     Aider ships one later, add it to the export in the plugin's install
#     steps — the wrapper itself doesn't care what invoked it.
#
# References (verified 2026-08):
#   * https://github.com/Aider-AI/aider/blob/main/aider/run_cmd.py
#   * https://aider.chat/docs/config/options.html
#   * https://github.com/Aider-AI/aider/issues/1215
#
# Contract:
#   $0 -i -c '<command string>'      ← Aider's pexpect path
#   $0 -c '<command string>'         ← plain POSIX shell -c invocation
#   $0 <argv...>                     ← fallback: join argv as the command
#   $0                               ← no argv: exec real shell interactively
# Exits with the exit code of the wrapped command.

set -uo pipefail

REDLOG_DIR="$HOME/.redlog"
REDLOG_PORT_FILE="$REDLOG_DIR/api-port"
REDLOG_TOKEN_FILE="$REDLOG_DIR/api-token"
HOOK_CONFIG="$REDLOG_DIR/hook-config.json"

# The shell we hand the command off to. Never call ourselves recursively.
REAL_SHELL="${REDLOG_AIDER_REAL_SHELL:-/bin/sh}"

# --- Parse argv into a single command string ---
# Accept any leading flags (`-i`, `-l`, `-i -c`, `-c`) before the payload.
INTERACTIVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c)
      shift
      CMD="${1:-}"
      shift || true
      break
      ;;
    -i|--interactive)
      INTERACTIVE=1
      shift
      ;;
    -l|--login)
      shift
      ;;
    --)
      shift
      CMD="$*"
      break
      ;;
    *)
      CMD="$*"
      break
      ;;
  esac
done
CMD="${CMD:-}"

# --- Emit event helper. Never fails, never blocks the command. ---
_redlog_send_event() {
  local subtype="$1" command="$2" extra="${3:-}"
  [[ -f "$REDLOG_PORT_FILE" && -f "$REDLOG_TOKEN_FILE" ]] || return 0
  local port token
  port=$(<"$REDLOG_PORT_FILE")
  token=$(<"$REDLOG_TOKEN_FILE")

  # cwd exclusion gate — the operator can opt personal dirs out of the log.
  local cwd; cwd="$PWD"
  if [[ -f "$HOOK_CONFIG" ]]; then
    local excluded
    excluded=$(python3 -c "
import json, os, sys
try:
    with open(os.environ['HOOK_CONFIG']) as f:
        cfg = json.load(f)
    ex = [os.path.expanduser(p).rstrip('/') for p in (cfg.get('excludedPaths') or []) if p]
    cwd = os.environ['PWD']
    if any(cwd == p or cwd.startswith(p + '/') for p in ex):
        print('1')
    else:
        print('0')
except Exception:
    print('0')
" 2>/dev/null) || excluded="0"
    [[ "$excluded" == "1" ]] && return 0
  fi

  # Recording-state gate — bail if RedLog is paused.
  local recording
  recording=$(curl -sf --connect-timeout 1 --max-time 1 \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${port}/api/recording" 2>/dev/null \
    | python3 -c "import json, sys
try: print('1' if json.load(sys.stdin).get('recording') else '0')
except Exception: print('0')" 2>/dev/null) || recording="0"
  [[ "$recording" == "1" ]] || return 0

  local payload
  payload=$(HOOK_EXTRA="$extra" HOOK_SUBTYPE="$subtype" HOOK_COMMAND="$command" HOOK_CWD="$cwd" HOOK_PID="$$" python3 -c "
import json, os
d = {
    'agent_type': 'agent',
    'data': {
        'subtype': os.environ['HOOK_SUBTYPE'],
        'command': os.environ['HOOK_COMMAND'],
        'source': 'aider-wrapper',
        'wrapper': 'aider-wrapper',
        'cwd': os.environ['HOOK_CWD'],
        'pid': int(os.environ['HOOK_PID']),
    }
}
extra = os.environ.get('HOOK_EXTRA') or ''
if extra:
    try:
        d['data'].update(json.loads(extra))
    except Exception:
        pass
print(json.dumps(d))
" 2>/dev/null) || return 0

  # IPv4 loopback only; short timeouts so a paused RedLog never blocks Aider.
  # Fire-and-forget so command_start doesn't add latency to the wrapped command.
  curl -sf -X POST "http://127.0.0.1:${port}/api/events" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 1 --max-time 2 >/dev/null 2>&1 &
}

# --- Run the wrapped command, bracketed by events ---
if [[ -z "$CMD" ]]; then
  # No command — behave like an interactive shell so nothing breaks if Aider
  # (or the user) exec's us bare. This also lets `SHELL=aider-wrapper.sh` be
  # safe to set globally.
  exec "$REAL_SHELL" -i
fi

_redlog_send_event "command_start" "$CMD"
START=$SECONDS

if [[ "$INTERACTIVE" == "1" ]]; then
  "$REAL_SHELL" -i -c "$CMD"
else
  "$REAL_SHELL" -c "$CMD"
fi
EXIT_CODE=$?

DURATION=$(( SECONDS - START ))
_redlog_send_event "command_end" "$CMD" \
  "{\"exit_code\":$EXIT_CODE,\"duration_sec\":$DURATION}"

exit $EXIT_CODE
