#!/usr/bin/env bash
# RedLog × Codex Native Hook (Tier A)
#
# Registered from Codex's hook config (~/.config/codex/config.toml). Codex is
# expected to pipe a JSON event payload on stdin — this script mirrors the
# claude-code-hook.sh contract (session_id / tool_name / tool_input /
# tool_response). If a Codex payload field is missing, the entry is degraded
# gracefully rather than dropped.
#
# TODO: verify against upstream docs — the exact stdin JSON schema for Codex
# hooks (https://developers.openai.com/codex/hooks/) may differ. Field
# extractors below are written defensively so most plausible shapes still land
# a usable event on the timeline; tighten once the schema is confirmed.
#
# Deliberately does NOT use `set -euo pipefail` — a hook that fires per tool
# call is a hot path and must NEVER surface an error to the agent.

# --- Resolve RedLog dir + creds ---
REDLOG_DIR="$HOME/.redlog"
REDLOG_PORT_FILE="$REDLOG_DIR/api-port"
REDLOG_TOKEN_FILE="$REDLOG_DIR/api-token"
[[ -f "$REDLOG_PORT_FILE" ]] || exit 0
[[ -f "$REDLOG_TOKEN_FILE" ]] || exit 0
PORT=$(<"$REDLOG_PORT_FILE")
TOKEN=$(<"$REDLOG_TOKEN_FILE")

# --- Read Codex payload from stdin (timeout guards a wedged stdin) ---
INPUT=$(timeout 2 cat 2>/dev/null)
[[ -n "$INPUT" ]] || exit 0

HOOK_CONFIG="$REDLOG_DIR/hook-config.json"

export INPUT
export REDLOG_PORT="$PORT"
export REDLOG_TOKEN="$TOKEN"
export HOOK_CONFIG
export MAX_OUTPUT="${REDLOG_MAX_OUTPUT:-500}"
export REDACT_SECRETS="${REDLOG_REDACT_SECRETS:-1}"
export CAPTURE_OUTPUT="${REDLOG_CAPTURE_OUTPUT:-1}"

# One python3 pass: parse, apply the two-gate privacy filter (cwd exclusion +
# RedLog recording state), redact secrets, emit an event payload.
PAYLOAD=$(python3 <<'PY' 2>/dev/null
import json, os, re, sys, urllib.request

raw = os.environ.get("INPUT", "")
try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

# Codex payload fields — defensive lookups (see TODO in header). We accept
# either `tool_input.command` or a top-level `command`, and fall back to the
# whole tool_input dict as a JSON blob if neither is present.
tool_name    = payload.get("tool_name") or payload.get("tool") or "unknown"
tool_input   = payload.get("tool_input") or payload.get("input") or {}
tool_resp    = payload.get("tool_response") or payload.get("output") or {}
session_id   = payload.get("session_id") or payload.get("sessionId") or ""
cwd          = payload.get("cwd") or os.getcwd() or ""

if isinstance(tool_input, dict):
    command = tool_input.get("command") or tool_input.get("cmd") or ""
    if not command:
        try:
            command = json.dumps(tool_input)[:500]
        except Exception:
            command = ""
else:
    command = str(tool_input)[:500]

# --- Gate 1: cwd exclusion (personal folders opted out of the audit log) ---
excluded_paths = []
try:
    with open(os.environ["HOOK_CONFIG"]) as f:
        cfg = json.load(f)
        excluded_paths = cfg.get("excludedPaths") or []
except Exception:
    pass
if excluded_paths:
    ex = [os.path.expanduser(p).rstrip("/") for p in excluded_paths if p]
    if any(cwd == p or cwd.startswith(p + "/") for p in ex):
        sys.exit(0)

# --- Gate 2: RedLog is actively recording ---
try:
    port  = os.environ["REDLOG_PORT"]
    token = os.environ["REDLOG_TOKEN"]
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/recording",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=1) as resp:
        rec = json.loads(resp.read().decode()).get("recording", False)
except Exception:
    sys.exit(0)
if not rec:
    sys.exit(0)

# --- Output preview + redaction (same regex block as claude-code-hook.sh) ---
capture = os.environ.get("CAPTURE_OUTPUT", "1") == "1"
max_out = int(os.environ.get("MAX_OUTPUT", "500") or 500)
redact  = os.environ.get("REDACT_SECRETS", "1") == "1"

output = ""
if capture:
    if isinstance(tool_resp, dict):
        output = tool_resp.get("output") or tool_resp.get("stdout") or ""
        if not output:
            try:
                output = json.dumps(tool_resp)[:max_out]
            except Exception:
                output = ""
    else:
        output = str(tool_resp)
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

sensitive_paths = [".claude/", ".ssh/", ".env", ".netrc", "credentials", ".aws/"]
if any(p in command for p in sensitive_paths):
    output = "[output hidden — sensitive path]"

data = {
    "agent_type": "agent",
    "data": {
        "subtype": "codex_tool",
        "tool": tool_name,
        "tool_input": tool_input if isinstance(tool_input, (dict, list, str)) else str(tool_input),
        "command": command,
        "output_preview": output,
        "session_id": session_id,
        "cwd": cwd,
        "wrapper": "codex-hook",
    },
}
print(json.dumps(data))
PY
)

[[ -n "$PAYLOAD" ]] || exit 0

# IPv4 loopback only — short timeouts so a paused RedLog never wedges Codex.
curl -sf -X POST "http://127.0.0.1:${PORT}/api/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true

# Always succeed — a failed capture must never block the agent.
exit 0
