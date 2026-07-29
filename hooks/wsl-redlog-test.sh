#!/usr/bin/env bash
# RedLog WSL Integration Test
# Diagnoses the WSL → Windows RedLog connection: environment, token path,
# API reachability, and a live event round-trip.
#
# Run from inside WSL:
#   bash /mnt/c/Users/<you>/Desktop/REDLOG/hooks/wsl-redlog-test.sh

set -u
OK="\033[32m✓\033[0m"
FAIL="\033[31m✗\033[0m"
WARN="\033[33m!\033[0m"
pass=0; fail=0

step() { printf "\n\033[1m── %s\033[0m\n" "$1"; }
ok()   { printf "  $OK %s\n" "$1"; ((pass++)); }
fail() { printf "  $FAIL %s\n" "$1"; ((fail++)); }
warn() { printf "  $WARN %s\n" "$1"; }

# 1. WSL environment
step "WSL Environment"
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  ok "Running inside WSL ($WSL_DISTRO_NAME)"
else
  fail "Not running inside WSL — this script is for WSL→Windows testing"
  exit 1
fi

MODE=$(wslinfo --networking-mode 2>/dev/null || echo "unknown")
if [[ "$MODE" == "mirrored" ]]; then
  ok "Networking mode: mirrored (localhost shared)"
else
  warn "Networking mode: $MODE — mirrored mode recommended"
  echo "      Fix: create %USERPROFILE%\\.wslconfig with [wsl2] networkingMode=mirrored"
  echo "      then: wsl --shutdown (from Windows PowerShell)"
fi

# 2. Token path resolution
step "Token Path Resolution"
WIN_PROFILE=$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')
if [[ -n "$WIN_PROFILE" ]]; then
  ok "Windows USERPROFILE: $WIN_PROFILE"
  WSL_PROFILE=$(wslpath "$WIN_PROFILE" 2>/dev/null)
  ok "WSL path: $WSL_PROFILE"
else
  fail "Cannot resolve Windows USERPROFILE"
  exit 1
fi

TOKEN_FILE="$WSL_PROFILE/.redlog/api-token"
PORT_FILE="$WSL_PROFILE/.redlog/api-port"

if [[ -f "$TOKEN_FILE" ]]; then
  ok "Token file found: $TOKEN_FILE"
else
  fail "Token file missing: $TOKEN_FILE"
  echo "      → Is RedLog running on Windows with a project open?"
fi

if [[ -f "$PORT_FILE" ]]; then
  PORT=$(<"$PORT_FILE")
  ok "Port file found: port=$PORT"
else
  fail "Port file missing: $PORT_FILE"
  echo "      → Is RedLog running on Windows with a project open?"
  exit 1
fi

TOKEN=$(<"$TOKEN_FILE")

# 3. API reachability
step "API Reachability"
HOST=""
if curl -sf --connect-timeout 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  ok "127.0.0.1:$PORT reachable (mirrored networking)"
  HOST="127.0.0.1"
else
  warn "127.0.0.1:$PORT not reachable"
  GW=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
  if [[ -n "$GW" ]] && curl -sf --connect-timeout 2 "http://${GW}:${PORT}/api/health" >/dev/null 2>&1; then
    ok "Gateway ${GW}:$PORT reachable (NAT mode)"
    HOST="$GW"
  else
    fail "RedLog API not reachable from WSL"
    echo "      → Check: is RedLog running? Is mirrored networking enabled?"
    exit 1
  fi
fi

# 4. Event round-trip
step "Event Round-Trip"
BEFORE=$(curl -sf "http://${HOST}:${PORT}/api/events/count" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)

PAYLOAD='{"agent_type":"shell","data":{"subtype":"wsl_test","command":"wsl-redlog-test.sh","shell":"bash","pid":'$$'}}'
RESP=$(curl -sf -X POST "http://${HOST}:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" --connect-timeout 2 --max-time 3 2>&1)

if [[ $? -eq 0 ]]; then
  ok "Test event sent successfully"
else
  fail "Failed to send test event: $RESP"
fi

AFTER=$(curl -sf "http://${HOST}:${PORT}/api/events/count" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)

if [[ "$AFTER" -gt "$BEFORE" ]]; then
  ok "Event persisted (count: $BEFORE → $AFTER)"
else
  warn "Event count unchanged ($BEFORE → $AFTER) — event may not have been persisted"
fi

# Summary
step "Summary"
printf "  Passed: %d  Failed: %d\n" "$pass" "$fail"
if [[ $fail -eq 0 ]]; then
  printf "\n  $OK WSL → RedLog integration is working.\n\n"
else
  printf "\n  $FAIL Some checks failed — see above for remediation.\n\n"
fi
