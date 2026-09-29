#!/usr/bin/env bash
# RedLog Agent Hook — source or call from AI agents (Claude, Codex, etc.)
# Sends events to RedLog's HTTP API for recording in the timeline.
#
# Usage:
#   source shell/redlog-agent.sh
#   redlog_mark "Found SQLi on login endpoint"
#   redlog_event "agent" '{"subtype":"scan_complete","target":"example.com","findings":3}'
#   redlog_note "Switching to manual testing for auth bypass"
#   redlog_search "password"
#   redlog_loot "root:x:0:0:root:/root:/bin/bash"

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

_redlog_get() {
  local endpoint="$1"
  local port token

  [[ -f "$_REDLOG_PORT_FILE" ]] || { echo "[redlog] not running" >&2; return 1; }
  [[ -f "$_REDLOG_TOKEN_FILE" ]] || { echo "[redlog] no token" >&2; return 1; }

  port=$(<"$_REDLOG_PORT_FILE")
  token=$(<"$_REDLOG_TOKEN_FILE")

  curl -sf "http://127.0.0.1:${port}${endpoint}" \
    -H "Authorization: Bearer $token" \
    --connect-timeout 2 --max-time 5
}

_json_escape() {
  python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' <<< "$1"
}

# Register this session so RedLog captures only explicitly opted-in sessions
# instead of every Claude Code session on the machine. Call once at session
# start, before any other redlog_* function. Falls back to $CLAUDE_SESSION_ID
# and the current directory when arguments are omitted.
redlog_session_register() {
  local session_id="${1:-${CLAUDE_SESSION_ID:-}}"
  local cwd="${2:-$PWD}"
  if [[ -z "$session_id" ]]; then
    echo "[redlog] redlog_session_register: session_id required (pass it or set CLAUDE_SESSION_ID)" >&2
    return 1
  fi
  _redlog_post "/api/session/register" \
    "{\"session_id\":$(_json_escape "$session_id"),\"cwd\":$(_json_escape "$cwd")}"
}

# Create a timestamp marker (most common action)
redlog_mark() {
  local title="${1:-Agent mark}"
  local note="${2:-}"
  local severity="${3:-info}"
  _redlog_post "/api/marker" \
    "{\"title\":$(_json_escape "$title"),\"notes\":$(_json_escape "$note"),\"severity\":$(_json_escape "$severity")}"
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

# Search events
redlog_search() {
  local query="$1"
  local limit="${2:-20}"
  _redlog_get "/api/events/search?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))")&limit=$limit"
}

# Scan text for loot (credentials, secrets)
redlog_loot() {
  local text="$1"
  _redlog_post "/api/loot/scan" \
    "{\"text\":$(_json_escape "$text")}"
}

# Get scope info
redlog_scope() {
  _redlog_get "/api/scope"
}

# Get config
redlog_config() {
  _redlog_get "/api/config"
}

# Create a private bookmark
redlog_bookmark() {
  local title="$1"
  local url="${2:-}"
  local note="${3:-}"
  _redlog_post "/api/bookmarks" \
    "{\"title\":$(_json_escape "$title"),\"url\":$(_json_escape "$url"),\"note\":$(_json_escape "$note")}"
}

# Capture screenshot
redlog_screenshot() {
  _redlog_post "/api/screenshot" "{}"
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
