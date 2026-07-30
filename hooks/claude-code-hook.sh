#!/usr/bin/env bash
# RedLog × Claude Code Hook
# Captures every Bash tool call and sends it to RedLog's timeline.
#
# Setup in Claude Code settings (~/.claude/settings.json):
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [{ "command": "/path/to/redlog/hooks/claude-code-hook.sh" }]
#         }
#       ]
#     }
#   }
#
# Claude Code hook API (as of 2026): the tool payload is delivered on STDIN
# as a single JSON object. The old CLAUDE_TOOL_* env-var contract that this
# file used to read is gone; anything that expects it silently no-ops. Shape:
#   {
#     "session_id": "...",
#     "transcript_path": "...",   ← pointer to full conversation .jsonl
#     "cwd": "...",
#     "hook_event_name": "PostToolUse",
#     "tool_name": "Bash",
#     "tool_input":  {"command": "...", ...},
#     "tool_response": {"output": "...", "stderr": "...", ...}   // PostToolUse
#   }
#
# We record the command + output preview + a POINTER to the transcript. We
# deliberately do NOT copy the surrounding conversation content into the
# chain: it's Anthropic-owned content, it would bloat the chain by orders
# of magnitude, and the transcript_path already provides audit trail on
# demand.
#
# Privacy controls (set in your shell profile or project .env):
#   REDLOG_CAPTURE_OUTPUT=0     — disable output capture entirely (default: 1)
#   REDLOG_MAX_OUTPUT=500       — max output chars to capture (default: 500)
#   REDLOG_REDACT_SECRETS=1     — redact API keys/tokens/passwords (default: 1)

# NOTE: intentionally NOT using `set -euo pipefail`. A hook that fires per
# tool call is a hot path — a stray failure inside jq/python or the API
# server being down must never surface as a Claude-Code UX error.

# --- Resolve RedLog dir (native or WSL) ---
_resolve_redlog_dir() {
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

REDLOG_DIR=$(_resolve_redlog_dir) || exit 0
REDLOG_PORT_FILE="$REDLOG_DIR/api-port"
REDLOG_TOKEN_FILE="$REDLOG_DIR/api-token"

[[ -f "$REDLOG_PORT_FILE" ]] || exit 0
[[ -f "$REDLOG_TOKEN_FILE" ]] || exit 0

PORT=$(<"$REDLOG_PORT_FILE")
TOKEN=$(<"$REDLOG_TOKEN_FILE")

# --- Read Claude Code's JSON payload from stdin ---
# Timeout guards against a hook wiring that happens to leave stdin open.
INPUT=$(timeout 2 cat 2>/dev/null)
[[ -n "$INPUT" ]] || exit 0

export INPUT
export CAPTURE_OUTPUT="${REDLOG_CAPTURE_OUTPUT:-1}"
export MAX_OUTPUT="${REDLOG_MAX_OUTPUT:-500}"
export REDACT_SECRETS="${REDLOG_REDACT_SECRETS:-1}"

# One python3 call handles JSON parse + redaction + payload build so nothing
# has to shuttle raw command text through the shell. Stderr suppressed —
# a hook error must not leak to Claude Code's terminal.
PAYLOAD=$(python3 <<'PY' 2>/dev/null
import json, os, re, sys

raw = os.environ.get("INPUT", "")
try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

if payload.get("tool_name") != "Bash":
    sys.exit(0)

tool_input = payload.get("tool_input") or {}
command = tool_input.get("command", "")
if not command:
    sys.exit(0)

capture = os.environ.get("CAPTURE_OUTPUT", "1") == "1"
max_out = int(os.environ.get("MAX_OUTPUT", "500") or 500)
redact = os.environ.get("REDACT_SECRETS", "1") == "1"

output = ""
if capture:
    resp = payload.get("tool_response") or {}
    # Different Claude Code versions used "output" and "stdout"; try both.
    output = resp.get("output") or resp.get("stdout") or ""
    if not output and isinstance(resp, dict):
        try:
            output = json.dumps(resp)[:max_out]
        except Exception:
            output = ""
    if len(output) > max_out:
        output = output[:max_out] + "..."

if redact and output:
    patterns = [
        (r"(?i)(api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization)[=: ]+\S+", r"\1=[REDACTED]"),
        (r"(?i)bearer\s+[A-Za-z0-9_\-\.]+", "Bearer [REDACTED]"),
        (r"AKIA[0-9A-Z]{16}", "[AWS_KEY_REDACTED]"),
        (r"(?i)(sk-|sk_live_|sk_test_)[A-Za-z0-9_\-]{20,}", "[API_KEY_REDACTED]"),
        (r"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----", "[PRIVATE_KEY_REDACTED]"),
        (r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[JWT_REDACTED]"),
        (r"ghp_[A-Za-z0-9]{36}", "[GITHUB_TOKEN_REDACTED]"),
        (r"glpat-[A-Za-z0-9_\-]{20}", "[GITLAB_TOKEN_REDACTED]"),
    ]
    for pat, repl in patterns:
        output = re.sub(pat, repl, output)

# Redact sensitive-path reads at the command level too — the operator doesn't
# want a screen full of API tokens even if the hook is running with elevated
# visibility.
sensitive_paths = [".claude/", ".ssh/", ".env", ".netrc", "credentials", ".aws/"]
if any(p in command for p in sensitive_paths):
    output = "[output hidden — sensitive path]"

data = {
    "agent_type": "agent",
    "data": {
        "subtype": "claude_code_bash",
        "command": command,
        "output_preview": output,
        # transcript_path lets an auditor open the full conversation on
        # demand without inflating the chain with copied AI content.
        "transcript_path": payload.get("transcript_path", ""),
        "session_id": payload.get("session_id", ""),
        "cwd": payload.get("cwd", ""),
        "tool": "Bash",
    },
}
print(json.dumps(data))
PY
)

# python3 exited without writing (empty output, wrong tool, missing keys) —
# nothing to log for this event.
[[ -n "$PAYLOAD" ]] || exit 0

# --- Resolve reachable host (WSL bridges through the Windows host) ---
REDLOG_HOST="127.0.0.1"
if ! curl -sf --connect-timeout 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
    if [[ -n "$gw" ]] && curl -sf --connect-timeout 1 "http://${gw}:${PORT}/api/health" >/dev/null 2>&1; then
      REDLOG_HOST="$gw"
    fi
  fi
fi

curl -sf -X POST "http://${REDLOG_HOST}:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true

# Always succeed — a failed audit send must never break Claude Code's flow.
exit 0
