#!/usr/bin/env bash
# RedLog event sender — WSL-aware
# --------------------------------
# Send a single event to the RedLog timeline from any script or hook. Works on
# native Linux/macOS and inside WSL (reaching the RedLog API on the Windows
# host). Fire-and-forget: it silently no-ops (exit 0) if RedLog isn't running
# or isn't reachable, so it never breaks the calling script.
#
# Usage:
#   redlog-send.sh "<command>"                        # subtype defaults to command_start
#   redlog-send.sh "<command>" command_end            # different subtype
#   redlog-send.sh "<command>" command_end '{"exit_code":0}'   # extra JSON merged into data{}
#   AGENT_TYPE=agent redlog-send.sh "<command>"       # override agent_type (default: shell)
#
# Example — wrap a tool in a script hook:
#   redlog-send.sh "nmap -sV $TARGET" command_start
#   nmap -sV "$TARGET"
#   redlog-send.sh "nmap -sV $TARGET" command_end "{\"exit_code\":$?}"

set -uo pipefail

CMD="${1:-}"
SUBTYPE="${2:-command_start}"
EXTRA="${3:-}"
AGENT_TYPE="${AGENT_TYPE:-shell}"
[[ -n "${CMD}" ]] || exit 0

# --- locate api-port / api-token -------------------------------------------
# Native: $HOME/.redlog. WSL: the Windows app writes to the Windows user
# profile, so resolve %USERPROFILE% via wslpath.
_dir=""
if [[ -f "${HOME}/.redlog/api-port" ]]; then
  _dir="${HOME}/.redlog"
elif grep -qi microsoft /proc/version 2>/dev/null && command -v wslpath >/dev/null 2>&1; then
  _wp="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
  _wp="$(wslpath "${_wp}" 2>/dev/null || true)"
  [[ -n "${_wp}" && -f "${_wp}/.redlog/api-port" ]] && _dir="${_wp}/.redlog"
fi
[[ -n "${_dir}" ]] || exit 0

PORT="$(tr -d '\r\n' < "${_dir}/api-port" 2>/dev/null)"
TOKEN="$(tr -d '\r\n' < "${_dir}/api-token" 2>/dev/null)"
[[ -n "${PORT}" && -n "${TOKEN}" ]] || exit 0

# --- resolve a reachable host (cached to avoid re-probing every call) -------
# Under WSL2 mirrored networking / WSL1, 127.0.0.1 is shared. Under NAT, try
# the default gateway (Windows host) — reachable only if the API isn't bound to
# loopback-only; otherwise this sender simply no-ops.
_cache="${TMPDIR:-/tmp}/.redlog-host-${PORT}"
HOST=""
if [[ -f "${_cache}" ]]; then
  HOST="$(cat "${_cache}" 2>/dev/null)"
  curl -sf --connect-timeout 1 --max-time 2 "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1 || HOST=""
fi
if [[ -z "${HOST}" ]]; then
  _gw="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
  for _c in 127.0.0.1 "${_gw}"; do
    [[ -z "${_c}" ]] && continue
    if curl -sf --connect-timeout 1 --max-time 2 "http://${_c}:${PORT}/api/health" >/dev/null 2>&1; then
      HOST="${_c}"
      echo "${_c}" > "${_cache}" 2>/dev/null || true
      break
    fi
  done
fi
[[ -n "${HOST}" ]] || exit 0

# --- build payload ----------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  PAYLOAD="$(CMD="${CMD}" SUBTYPE="${SUBTYPE}" EXTRA="${EXTRA}" AGENT_TYPE="${AGENT_TYPE}" python3 -c '
import json, os
src = "native"
try:
    if "microsoft" in open("/proc/version").read().lower():
        src = "wsl"
except Exception:
    pass
d = {"agent_type": os.environ["AGENT_TYPE"],
     "data": {"subtype": os.environ["SUBTYPE"],
              "command": os.environ["CMD"],
              "shell": os.path.basename(os.environ.get("SHELL", "")),
              "source": src}}
ex = os.environ.get("EXTRA", "")
if ex:
    try:
        d["data"].update(json.loads(ex))
    except Exception:
        pass
print(json.dumps(d))')" || exit 0
else
  # Minimal fallback without python3 (no EXTRA merge; basic escaping).
  _esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  PAYLOAD="{\"agent_type\":\"${AGENT_TYPE}\",\"data\":{\"subtype\":\"${SUBTYPE}\",\"command\":\"$(_esc "${CMD}")\",\"source\":\"native\"}}"
fi

# --- fire-and-forget send ---------------------------------------------------
curl -sf -X POST "http://${HOST}:${PORT}/api/events" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true
exit 0
