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

set -euo pipefail

REDLOG_PORT_FILE="$HOME/.redlog/api-port"
REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"

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

OUTPUT_PREVIEW="${CLAUDE_TOOL_OUTPUT:-}"
if [[ ${#OUTPUT_PREVIEW} -gt 500 ]]; then
  OUTPUT_PREVIEW="${OUTPUT_PREVIEW:0:500}..."
fi

PAYLOAD=$(python3 -c '
import json, sys, os
print(json.dumps({
    "agent_type": "agent",
    "data": {
        "subtype": "claude_code_bash",
        "command": os.environ.get("COMMAND", ""),
        "output_preview": os.environ.get("OUTPUT_PREVIEW", ""),
        "session_id": os.environ.get("CLAUDE_SESSION_ID", ""),
        "tool": "Bash"
    }
}))
' 2>/dev/null)

curl -sf -X POST "http://127.0.0.1:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true
