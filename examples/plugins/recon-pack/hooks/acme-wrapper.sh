#!/usr/bin/env bash
# Example capture hook for the recon-pack plugin.
# Wraps a bespoke CLI so every invocation is recorded to RedLog's timeline.
# RedLog only records while the app is open (it reads ~/.redlog/api-port|token).

REDLOG_PORT_FILE="$HOME/.redlog/api-port"
REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"

_redlog_send() {
  [[ -f "$REDLOG_PORT_FILE" && -f "$REDLOG_TOKEN_FILE" ]] || return 0
  local port token
  port=$(<"$REDLOG_PORT_FILE"); token=$(<"$REDLOG_TOKEN_FILE")
  curl -s -m 2 -X POST "http://127.0.0.1:${port}/api/events" \
    -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
    -d "$(python3 - "$@" <<'PY'
import json, sys
print(json.dumps({"agent_type": "acme_scan", "data": {"subtype": "invoke", "command": " ".join(sys.argv[1:])}}))
PY
)" >/dev/null 2>&1 || true
}

_redlog_send "$@"
exec acme-cli "$@"
