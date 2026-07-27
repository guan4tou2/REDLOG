#!/usr/bin/env bash
# RedLog Agent Hook — source or call from AI agents (Claude, etc.)
# Sends events to RedLog's HTTP API for recording in the timeline.
#
# Usage:
#   source shell/redlog-agent.sh
#   redlog_mark "Found SQLi on login endpoint"
#   redlog_event "agent" '{"subtype":"scan_complete","target":"example.com","findings":3}'
#   redlog_note "Switching to manual testing for auth bypass"

_REDLOG_PORT_FILE="$HOME/.redlog/api-port"
_REDLOG_TOKEN_FILE="$HOME/.redlog/api-token"

_redlog_post() {
  local endpoint="$1" payload="$2"
  local port token

  [[ -f "$_REDLOG_PORT_FILE" ]] || { echo "[redlog] not running" >&2; return 1; }
  [[ -f "$_REDLOG_TOKEN_FILE" ]] || { echo "[redlog] no token" >&2; return 1; }

  port=$(<"$_REDLOG_PORT_FILE")
  token=$(<"$_REDLOG_TOKEN_FILE")

  curl -sf -X POST "http://127.0.0.1:${port}${endpoint}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 2 --max-time 5
}

_json_escape() {
  python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' <<< "$1"
}

# Create a timestamp marker (most common action)
redlog_mark() {
  local title="${1:-Agent mark}"
  local note="${2:-}"
  local severity="${3:-info}"
  _redlog_post "/api/marker" \
    "{\"title\":$(_json_escape "$title"),\"notes\":$(_json_escape "$note")}"
}

# Send a raw event with custom agent_type and data
redlog_event() {
  local agent_type="${1:-agent}"
  local data="${2:-{}}"
  _redlog_post "/api/events" \
    "{\"agent_type\":$(_json_escape "$agent_type"),\"data\":$data}"
}

# Quick note — creates a marker with category=note
redlog_note() {
  local text="$1"
  _redlog_post "/api/marker" \
    "{\"title\":\"Agent Note\",\"notes\":$(_json_escape "$text")}"
}

# Check if RedLog is running
redlog_status() {
  if [[ -f "$_REDLOG_PORT_FILE" ]] && [[ -f "$_REDLOG_TOKEN_FILE" ]]; then
    local port=$(<"$_REDLOG_PORT_FILE")
    local token=$(<"$_REDLOG_TOKEN_FILE")
    local resp
    resp=$(curl -sf "http://127.0.0.1:${port}/api/status" \
      -H "Authorization: Bearer $token" \
      --connect-timeout 1 --max-time 2 2>/dev/null)
    if [[ $? -eq 0 ]]; then
      echo "[redlog] running on port $port"
      echo "$resp"
      return 0
    fi
  fi
  echo "[redlog] not running"
  return 1
}
