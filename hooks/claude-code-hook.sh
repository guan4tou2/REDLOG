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
# Environment variables set by Claude Code:
#   CLAUDE_TOOL_NAME    — tool name (e.g. "Bash")
#   CLAUDE_TOOL_INPUT   — JSON string of tool input
#   CLAUDE_TOOL_OUTPUT  — JSON string of tool output (PostToolUse only)
#   CLAUDE_SESSION_ID   — current session ID
#
# Privacy controls (set in your shell profile or project .env):
#   REDLOG_CAPTURE_OUTPUT=0     — disable output capture entirely (default: 1)
#   REDLOG_MAX_OUTPUT=500       — max output chars to capture (default: 500)
#   REDLOG_REDACT_SECRETS=1     — redact API keys/tokens/passwords (default: 1)

set -euo pipefail

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

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
TOOL_INPUT="${CLAUDE_TOOL_INPUT:-{}}"

[[ "$TOOL_NAME" == "Bash" ]] || exit 0

COMMAND=$(echo "$TOOL_INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("command", ""))
except: pass
' 2>/dev/null)

[[ -n "$COMMAND" ]] || exit 0

CAPTURE_OUTPUT="${REDLOG_CAPTURE_OUTPUT:-1}"
MAX_OUTPUT="${REDLOG_MAX_OUTPUT:-500}"
REDACT_SECRETS="${REDLOG_REDACT_SECRETS:-1}"

OUTPUT_PREVIEW=""
if [[ "$CAPTURE_OUTPUT" == "1" ]]; then
  OUTPUT_PREVIEW="${CLAUDE_TOOL_OUTPUT:-}"
  if [[ ${#OUTPUT_PREVIEW} -gt $MAX_OUTPUT ]]; then
    OUTPUT_PREVIEW="${OUTPUT_PREVIEW:0:$MAX_OUTPUT}..."
  fi
fi

export COMMAND OUTPUT_PREVIEW REDACT_SECRETS

PAYLOAD=$(python3 -c '
import json, os, re

output = os.environ.get("OUTPUT_PREVIEW", "")
command = os.environ.get("COMMAND", "")
redact = os.environ.get("REDACT_SECRETS", "1")

# Redact sensitive patterns from output
if redact == "1" and output:
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
    for pattern, replacement in patterns:
        output = re.sub(pattern, replacement, output)

# Redact sensitive file reads from command
sensitive_paths = [".claude/", ".ssh/", ".env", ".netrc", "credentials", ".aws/"]
cmd_reads_sensitive = any(p in command for p in sensitive_paths)

data = {
    "agent_type": "agent",
    "data": {
        "subtype": "claude_code_bash",
        "command": command,
        "output_preview": "[output hidden — sensitive path]" if cmd_reads_sensitive else output,
        "session_id": os.environ.get("CLAUDE_SESSION_ID", ""),
        "tool": "Bash"
    }
}
print(json.dumps(data))
' 2>/dev/null)

# --- Resolve reachable host ---
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
