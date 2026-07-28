#!/usr/bin/env bash
# RedLog × WSL hook test
# ----------------------
# Verifies that a shell running inside WSL can reach the RedLog API on the
# Windows host and log an event — exactly the path hooks/shell-preexec-hook.sh
# and hooks/claude-code-hook.sh use.
#
# Run from inside a WSL shell:
#   bash hooks/wsl-redlog-test.sh
#
# Why WSL needs special handling:
#   1. Token/port files: the Windows app writes ~/.redlog/api-{token,port} to the
#      Windows user profile, not WSL's Linux $HOME. This test resolves
#      %USERPROFILE% via wslpath.
#   2. Networking: the API binds 127.0.0.1 on Windows. Under WSL2 *mirrored*
#      networking (or WSL1) that loopback is shared, so 127.0.0.1 works. Under
#      the default WSL2 *NAT* mode it does not — enable mirrored networking.

set -uo pipefail

pass=0
fail=0
ok()   { echo "  [PASS] $*"; pass=$((pass + 1)); }
no()   { echo "  [FAIL] $*"; fail=$((fail + 1)); }
info() { echo "  [info] $*"; }

summary() {
  echo
  echo "Result: ${pass} passed, ${fail} failed"
  if [[ "${fail}" -eq 0 ]]; then
    echo "WSL → RedLog hook path: OK"
  else
    echo "WSL → RedLog hook path: NOT working (see notes above)"
  fi
  exit $(( fail > 0 ? 1 : 0 ))
}

echo "== RedLog WSL hook test =="

# 1) Confirm we are in WSL --------------------------------------------------
if grep -qi microsoft /proc/version 2>/dev/null; then
  ok "running inside WSL ($(uname -r))"
else
  no "not running inside WSL — run this from a WSL shell (wsl.exe bash hooks/wsl-redlog-test.sh)"
  summary
fi

# 2) Required tools ---------------------------------------------------------
for bin in curl wslpath; do
  command -v "${bin}" >/dev/null 2>&1 || no "missing required tool: ${bin}"
done

# 3) Locate the RedLog api-port / api-token ---------------------------------
REDLOG_DIR=""
if [[ -f "${HOME}/.redlog/api-port" ]]; then
  REDLOG_DIR="${HOME}/.redlog"
  info "using RedLog dir in Linux home: ${REDLOG_DIR}"
else
  # Resolve the Windows user profile (folder name may differ from %USERNAME%).
  winprofile="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
  if [[ -n "${winprofile}" ]]; then
    wprof="$(wslpath "${winprofile}" 2>/dev/null || true)"
    if [[ -n "${wprof}" && -f "${wprof}/.redlog/api-port" ]]; then
      REDLOG_DIR="${wprof}/.redlog"
      info "using RedLog dir on Windows profile: ${REDLOG_DIR}"
    fi
  fi
fi

if [[ -z "${REDLOG_DIR}" ]]; then
  no "cannot find .redlog/api-port"
  echo
  echo "  RedLog must be running with a project open (that starts the API and"
  echo "  writes api-port/api-token). Open a project in RedLog, then re-run."
  summary
fi
ok "located RedLog api files"

PORT="$(tr -d '\r\n' < "${REDLOG_DIR}/api-port" 2>/dev/null)"
TOKEN="$(tr -d '\r\n' < "${REDLOG_DIR}/api-token" 2>/dev/null)"
[[ -n "${PORT}"  ]] && ok "api-port = ${PORT}" || no "api-port is empty"
[[ -n "${TOKEN}" ]] && ok "api-token present (${#TOKEN} chars)" || no "api-token is empty"
[[ -n "${PORT}" && -n "${TOKEN}" ]] || summary

# 4) Find a reachable host --------------------------------------------------
#    Try shared loopback first (mirrored networking / WSL1), then the WSL2
#    default gateway (the Windows host under NAT).
gw="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
HOST=""
for cand in 127.0.0.1 "${gw}"; do
  [[ -z "${cand}" ]] && continue
  if curl -sf --connect-timeout 1 --max-time 2 "http://${cand}:${PORT}/api/health" >/dev/null 2>&1; then
    HOST="${cand}"
    ok "/api/health reachable at ${cand}:${PORT}"
    break
  fi
  info "not reachable at ${cand}:${PORT}"
done

if [[ -z "${HOST}" ]]; then
  no "RedLog API not reachable from WSL"
  cat <<'EOF'

  The API binds 127.0.0.1 on Windows. Under WSL2 NAT networking (the default)
  WSL's localhost is a separate loopback, so it cannot reach it.

  Fix — enable WSL2 mirrored networking:
    1. Create/edit  %USERPROFILE%\.wslconfig  on Windows:
         [wsl2]
         networkingMode=mirrored
    2. From Windows PowerShell:  wsl --shutdown
    3. Reopen WSL and re-run this test. localhost is then shared with Windows.
EOF
  summary
fi

# 5) Round-trip: post an event and confirm the count increments -------------
base="http://${HOST}:${PORT}"
before="$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${base}/api/events/count" 2>/dev/null | grep -o '[0-9]\+' | head -1)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/api/events" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"agent_type":"shell","data":{"subtype":"command_start","command":"redlog-wsl-test echo hello","shell":"wsl-test"}}' \
  2>/dev/null)"
[[ "${code}" == "201" ]] && ok "POST /api/events accepted (HTTP 201)" || no "POST /api/events returned HTTP ${code:-none}"

after="$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${base}/api/events/count" 2>/dev/null | grep -o '[0-9]\+' | head -1)"
if [[ -n "${before}" && -n "${after}" && "${after}" -gt "${before}" ]]; then
  ok "event recorded (count ${before} → ${after})"
else
  no "event count did not increase (${before:-?} → ${after:-?})"
fi

summary
