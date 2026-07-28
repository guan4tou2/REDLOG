# RedLog AI Agent Integration

RedLog (Red Team Operation Log) is designed to work as a passive recorder for AI-driven penetration testing. This document covers all integration methods, from zero-config terminal hooks to full MCP control.

## Integration Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     AI Agent                            │
│  (Claude Code / Codex / GPT / Cursor / Aider / custom) │
└──────┬────────────────┬────────────────┬────────────────┘
       │                │                │
  ┌────▼────┐    ┌──────▼──────┐   ┌─────▼─────┐
  │ Terminal │    │ MCP Server  │   │ HTTP API  │
  │  Hooks   │    │ (12 tools)  │   │ (REST)    │
  │(passive) │    │  (active)   │   │(universal)│
  └────┬────┘    └──────┬──────┘   └─────┬─────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
              ┌─────────▼─────────┐
              │   RedLog Engine   │
              │  (SQLite + Event  │
              │   Bus + Timeline) │
              └───────────────────┘
```

**Passive hooks** capture everything without the agent knowing. **MCP/API** lets the agent actively query scope, create markers, and search history.

The recommended setup combines both: hooks for automatic command logging + MCP for agent-initiated actions.

## 1. Terminal Hooks (Passive Capture)

Terminal hooks intercept commands at the shell level. The agent doesn't need to be RedLog-aware — every command it runs is automatically logged with timestamps, exit codes, and duration.

### 1a. Claude Code — PostToolUse Hook

Claude Code's hook system fires a script after every tool call. Our hook captures Bash tool calls specifically.

**Setup:**

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "command": "/path/to/redlog/hooks/claude-code-hook.sh"
          }
        ]
      }
    ]
  }
}
```

Or per-project in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "command": "$PROJECT_DIR/hooks/claude-code-hook.sh"
          }
        ]
      }
    ]
  }
}
```

**What it captures:**

| Field | Source | Example |
|-------|--------|---------|
| command | `CLAUDE_TOOL_INPUT.command` | `nmap -sV target.com` |
| output_preview | `CLAUDE_TOOL_OUTPUT` (first 500 chars) | `Starting Nmap 7.94...` |
| session_id | `CLAUDE_SESSION_ID` | `abc123-def456` |
| subtype | hardcoded | `claude_code_bash` |

**Environment variables provided by Claude Code:**

- `CLAUDE_TOOL_NAME` — tool name (we filter for `"Bash"`)
- `CLAUDE_TOOL_INPUT` — JSON string of tool input parameters
- `CLAUDE_TOOL_OUTPUT` — JSON string of tool output (PostToolUse only)
- `CLAUDE_SESSION_ID` — current Claude Code session identifier

**Timeline appearance:** Events appear as `agent` type with subtype `claude_code_bash` in the Timeline swim-lane view.

### 1b. Shell Preexec Hook (Universal)

Works with ANY agent that spawns a shell process. Hooks into zsh `preexec`/`precmd` or bash `DEBUG` trap.

**Setup:**

```bash
# Add to ~/.zshrc
source /path/to/redlog/hooks/shell-preexec-hook.sh

# Or add to ~/.bashrc
source /path/to/redlog/hooks/shell-preexec-hook.sh
```

**What it captures:**

| Event | Timing | Fields |
|-------|--------|--------|
| `command_start` | Before command runs | command, shell, pid |
| `command_end` | After command completes | command, exit_code, duration_sec |

**How it works (zsh):**

1. `preexec` hook fires before each command — records the command text and start time
2. `precmd` hook fires after each command — records exit code and calculates duration
3. Events are sent to RedLog via HTTP API in the background (`curl ... &`)

**How it works (bash):**

1. `DEBUG` trap fires before each command
2. `PROMPT_COMMAND` fires after each command
3. Same event emission as zsh

**Performance:** Negligible. The `curl` call runs in background and has a 1-second timeout. If RedLog isn't running, the hook silently does nothing.

### 1c. Codex/GPT Wrapper

For agents where you can't modify their hook system but can control the shell they launch.

**Usage:**

```bash
# Option 1: Set as the agent's shell
SHELL=/path/to/redlog/hooks/codex-wrapper.sh codex run "scan the target"

# Option 2: Wrap a specific command
./hooks/codex-wrapper.sh nmap -sV target.com

# Option 3: Start a wrapped interactive shell
./hooks/codex-wrapper.sh
# (loads shell-preexec-hook.sh automatically)
```

**How it works:**

- If called with arguments: wraps that single command with start/end events
- If called without arguments: starts an interactive shell with preexec hooks loaded
- Sets `REDLOG_SHELL_WRAPPED=1` env var so tools can detect the wrapper

## 2. MCP Server (Agent-Controlled)

The MCP (Model Context Protocol) server lets compatible agents actively interact with RedLog — check scope before scanning, create markers for findings, search history, etc.

### Setup

```bash
# Claude Code
claude mcp add redlog -- node /path/to/redlog/mcp/redlog-mcp-server.js

# Cursor
# Add to .cursor/mcp.json:
{
  "mcpServers": {
    "redlog": {
      "command": "node",
      "args": ["/path/to/redlog/mcp/redlog-mcp-server.js"]
    }
  }
}

# Generic MCP client
node /path/to/redlog/mcp/redlog-mcp-server.js
# (uses stdio transport with Content-Length framing)
```

### Auto-Discovery

The MCP server automatically discovers a running RedLog instance by reading:

- `~/.redlog/api-port` — the HTTP API port (default 6660)
- `~/.redlog/api-token` — the Bearer auth token

These files are created when RedLog starts. If they don't exist, the MCP server returns an error message suggesting to launch RedLog first.

### Available Tools

#### `redlog_status`

Returns current IP addresses (external/internal), IP safety flag, total event count, and scope violation count.

**Parameters:** none

**Returns:**
```json
{
  "ip": {
    "externalIP": "203.0.113.42",
    "internalIP": "10.0.1.5",
    "ipSafety": "safe",
    "lastCheck": 1706400000000,
    "error": null
  },
  "eventCount": 1247,
  "scopeViolations": 3
}
```

#### `redlog_whoami`

Return the operator identity that this token resolves to. Every event logged under this token is attributed to this operator. Call once at session start to catch loaded-wrong-token mistakes.

**Parameters:** none

**Returns:**
```json
{
  "operator": {
    "id": "codex-agent-a1b2c3",
    "name": "Codex agent",
    "isPrimary": false,
    "createdAt": 1706300000000,
    "revokedAt": null
  },
  "engagementId": "client-pentest-q3"
}
```

#### `redlog_operators_list`

List every operator token registered on this RedLog instance.

**Returns:** `{ "operators": [ ... ] }` — each entry mirrors the `operator` object in `redlog_whoami`.

#### `redlog_chain_status`

Length of the SHA-256 hash chain and the latest OpenTimestamps anchor.

**Returns:**
```json
{
  "length": 1247,
  "lastAnchor": {
    "id": "…",
    "headHash": "9f2c…",
    "eventCount": 1200,
    "status": "complete",
    "createdAt": 1706398800000,
    "calendarReceipts": [
      { "calendar": "https://a.pool.opentimestamps.org", "ok": true, "receiptB64": "…" }
    ]
  }
}
```

#### `redlog_chain_anchor_now`

Submit the current chain head to public OpenTimestamps calendars immediately. Use before wrapping up a session or right after a critical finding.

#### `redlog_chain_verify`

Fast check: does the latest anchor still describe a prefix of the current chain? Compares event counts (not a full re-walk).

**Returns:** `{ "ok": true, "anchor": { … }, "currentHead": "9f2c…" }`

#### `redlog_mark`

Creates a timestamped marker in the timeline — used for findings, phase changes, and notes.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Marker title |
| notes | string | no | Detailed notes |
| severity | string | no | `info` / `low` / `medium` / `high` / `critical` |
| target_id | string | no | Associated target |

**Example:**
```json
{
  "title": "SQL Injection in /api/users",
  "notes": "Parameter 'id' is injectable — time-based blind, PostgreSQL",
  "severity": "high",
  "target_id": "api.example.com"
}
```

#### `redlog_log_event`

Logs a raw event with custom agent type and data payload.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agent_type | string | yes | Event category (`agent`, `scanner`, `recon`, `exploit`) |
| data | object | yes | Event payload (freeform JSON) |
| target_id | string | no | Associated target |

#### `redlog_search`

Full-text search across all events.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | yes | Search query |
| limit | number | no | Max results (default 20) |

#### `redlog_events`

Query recent events with filters.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agent_type | string | no | Filter by type |
| target_id | string | no | Filter by target |
| limit | number | no | Max results (default 50) |

#### `redlog_scope`

Returns scope configuration, target list, violations, and violation count.

**Returns:**
```json
{
  "targets": ["*.example.com", "10.0.0.0/8"],
  "excludeTargets": ["10.0.0.1"],
  "enforcement": "warn",
  "violations": [...],
  "violationCount": 3
}
```

#### `redlog_config`

Returns the full project configuration (engagement, operator, network, scope settings).

#### `redlog_quickmark`

Creates a bookmark for an interesting URL, endpoint, or finding.

**Parameters:**

| Param | Type | Required |
|-------|------|----------|
| title | string | yes |
| url | string | no |
| note | string | no |

#### `redlog_quickmarks_list`

Lists all bookmarks in the current project.

#### `redlog_loot_scan`

Scans arbitrary text for credentials, secrets, and sensitive data.

**Parameters:**

| Param | Type | Required |
|-------|------|----------|
| text | string | yes |

**Detected patterns:** AWS keys, API tokens, JWTs, password hashes, private keys, database connection strings, CTF flags.

#### `redlog_screenshot`

Captures a screenshot and saves it to the project's screenshot directory.

#### `redlog_recording`

Controls recording state.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| action | string | yes | `pause` / `resume` / `toggle` |

### Building a Claude Code Skill

Ship-ready skill file at [`docs/skills/redlog-pentest.md`](skills/redlog-pentest.md). Install with:

```bash
cp docs/skills/redlog-pentest.md ~/.claude/skills/redlog-pentest.md
# or per-project
cp docs/skills/redlog-pentest.md .claude/skills/redlog-pentest.md
```

The skill covers the full loop: session start (`whoami` + `status` + `scope`), real-time findings via `redlog_mark`, loot scanning, and end-of-session `chain_anchor_now`. Read [the skill](skills/redlog-pentest.md) directly for the exact flow.

## 3. HTTP API

Direct REST API for scripts, custom agents, and non-MCP tools. Runs on `127.0.0.1:6660` (configurable).

### Authentication

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)

# GET request
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status

# POST request
curl -X POST http://127.0.0.1:$PORT/api/marker \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Finding","severity":"high"}'
```

### Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/health` | no | Health check |
| GET | `/api/whoami` | yes | Resolve token → operator |
| GET | `/api/status` | yes | System status (IP, events, violations) |
| GET | `/api/config` | yes | Project configuration |
| GET | `/api/scope` | yes | Scope targets + violations |
| GET | `/api/recording` | yes | Recording state |
| POST | `/api/recording` | yes | Control recording (`{"action":"pause\|resume\|toggle"}`) |
| POST | `/api/events` | yes | Insert event (operator_id set from token) |
| GET | `/api/events` | yes | Query events (`?agent_type=&limit=&target_id=&since=`) |
| GET | `/api/events/search` | yes | Search events (`?q=&limit=`) |
| GET | `/api/events/count` | yes | Event count |
| POST | `/api/marker` | yes | Create marker |
| GET | `/api/quickmarks` | yes | List bookmarks |
| POST | `/api/quickmarks` | yes | Create bookmark |
| POST | `/api/loot/scan` | yes | Scan for secrets |
| POST | `/api/screenshot` | yes | Trigger manual capture |
| GET | `/api/operators` | yes | List operators (any valid token) |
| POST | `/api/operators` | primary | Create operator, returns token **once** |
| PATCH | `/api/operators/:id` | primary | Rename |
| POST | `/api/operators/:id/rotate` | self or primary | Rotate token |
| POST | `/api/operators/:id/revoke` | primary | Revoke token |
| DELETE | `/api/operators/:id` | primary | Delete operator |
| GET | `/api/chain` | yes | Chain length + latest anchor |
| GET | `/api/anchors` | yes | List OTS anchors (`?limit=`) |
| POST | `/api/anchors` | yes | Anchor current chain head now |
| GET | `/api/anchors/verify` | yes | Fast prefix check (add `?full=1` for full re-walk) |
| GET | `/api/anchors/:id/ots` | yes | Download standard `.ots` bundle (`?calendar=<url>` optional) |
| GET | `/api/clock` | yes | NTP offset + last query time + host wall clock |
| POST | `/api/export/bundle` | yes | Produce signed evidence bundle in project's `exports/` dir |
| GET | `/api/deconfliction` | yes | Current deconfliction config (secret redacted) |
| POST | `/api/deconfliction/test` | yes | Send a test payload to the configured webhook |

### Event Schema

```json
{
  "agent_type": "shell|scanner|agent|recon|exploit",
  "data": {
    "subtype": "command_start|command_end|scan_complete",
    "command": "nmap -sV target.com",
    "output": "..."
  },
  "target_id": "target.com"
}
```

### Marker Schema

```json
{
  "title": "Found SQLi in /api/users",
  "notes": "Parameter 'id' is injectable, time-based blind",
  "severity": "high",
  "target_id": "api.example.com"
}
```

## 4. Shell Functions

Source the helper script for quick access from any terminal:

```bash
source /path/to/redlog/shell/redlog-agent.sh
```

| Function | Description | Example |
|----------|-------------|---------|
| `redlog_status` | Check if RedLog is running | `redlog_status` |
| `redlog_mark` | Create a marker | `redlog_mark "Finding" "Details" "high"` |
| `redlog_event` | Log raw event | `redlog_event "agent" '{"subtype":"done"}'` |
| `redlog_note` | Quick note marker | `redlog_note "Switching to auth bypass"` |
| `redlog_search` | Search events | `redlog_search "password" 20` |
| `redlog_loot` | Scan for creds | `redlog_loot "root:x:0:0:..."` |
| `redlog_scope` | Get scope info | `redlog_scope` |
| `redlog_config` | Get project config | `redlog_config` |
| `redlog_quickmark` | Bookmark a URL | `redlog_quickmark "Endpoint" "https://..."` |
| `redlog_screenshot` | Manual capture | `redlog_screenshot` |

## 5. Codex / OpenAI Function Calling

See [`codex-tools.json`](codex-tools.json) for OpenAI-compatible function definitions. These work with Codex, GPT, or any OpenAI-API-compatible model.

**8 tool definitions included:**

1. `redlog_status` — get recording status
2. `redlog_mark` — create finding/phase marker
3. `redlog_log_event` — log arbitrary event
4. `redlog_search` — full-text search
5. `redlog_scope` — check scope config
6. `redlog_loot_scan` — scan for credentials
7. `redlog_screenshot` — capture screenshot
8. `redlog_recording` — control recording state

## Config Profile Sharing

Export your project config for team sync:

```bash
# In RedLog UI: Settings → Team Profile Sync → Export Profile
# Produces a YAML file like:

# redlog-profile-my-pentest.yaml
version: 1
engagement:
  id: client-pentest-q3
  name: "Client Pentest Q3"
scope:
  enforcement: warn
  targets:
    - "192.168.1.0/24"
    - "*.example.com"
network:
  vpnIPs:
    - "10.8.0.0/24"
```

Team members import this when creating a new project:
- **Project Picker** → Advanced Setup → Import Profile
- **Settings** → Team Profile Sync → Import Profile

## Proxied Browser

The title-bar **Launch Browser** button (also in Settings ▸ Data) starts a Chromium-based browser wired up for capture in one click:

| Flag | Why |
|---|---|
| `--proxy-server=<your proxy>` | mitmproxy sees the traffic, so it lands in the timeline as `scanner` events |
| `--proxy-bypass-list=<-loopback>` | Chrome bypasses the proxy for localhost by default — this re-enables capture for local targets |
| `--remote-debugging-port=<port>` | QuickMarks can read the active tab's URL and title |
| `--user-data-dir=<project>/browser-profile` | Project-local profile, so none of this touches your daily browsing |
| `--ignore-certificate-errors` | Required for mitmproxy's interception cert |

Launching logs a `system` event with `subtype: browser_launched` recording the binary, proxy, CDP port, and pid — so the report shows exactly which browser instance produced the captured traffic. The browser is terminated when RedLog quits.

Configure under Settings ▸ Data ▸ Proxied Browser, or in `config.yaml`:

```yaml
browser:
  binary: ""                        # blank = auto-detect Chrome/Chromium/Brave/Edge
  proxy: "http://127.0.0.1:8080"    # blank = no proxy flag
  cdpPort: 9222
  isolateProfile: true
  ignoreCertErrors: true
  startUrl: ""
  extraArgs: []
```

## Multi-Operator Setup

Each API token maps to one operator identity. The audit log tags every event with the operator resolved from the token — so several people (or several agents) can share one RedLog instance and stay distinguishable.

Full lifecycle in [docs/operators.md](operators.md). TL;DR:

1. **You** (primary): use RedLog's own generated token in `~/.redlog/api-token`. Rotated every app launch. Do nothing.
2. **Teammate**: Settings ▸ General ▸ Operator Tokens ▸ **Add operator** ▸ copy token once ▸ hand over securely. On their machine: `echo -n '<token>' > ~/.redlog/api-token && chmod 600 ~/.redlog/api-token`.
3. **Distinct agent context** on the same machine (e.g. Codex vs Claude): create a secondary token and have that agent use `REDLOG_TOKEN=<token>` instead of the file — patch the one hook that agent uses.

## Evidence Chain & OpenTimestamps

The `events` table is a SHA-256 hash chain (every row's `hash` covers the previous row's). Once an hour RedLog submits the chain head to three public OpenTimestamps calendars, producing receipts stored in `chain_anchors`. Anyone with a receipt can later prove the chain existed at that time — without touching your machine.

Agents should call `redlog_chain_anchor_now` right before ending a session so anything done in-session is timestamped in-session (don't wait for the hourly loop).

Details, threat model, and verification workflow: [docs/audit-trail.md](audit-trail.md).

## Recommended Setup

For maximum coverage with minimal friction:

1. **Install shell preexec hook** in `~/.zshrc` (captures everything from all agents)
2. **Add Claude Code PostToolUse hook** (captures structured tool call data)
3. **Add MCP server** to Claude Code (lets the agent actively check scope, create markers, anchor the chain)
4. **Install the [redlog-pentest skill](skills/redlog-pentest.md)** (guides the agent's RedLog usage)
5. **For each teammate: add a secondary operator** via Settings ▸ Operator Tokens so the audit log stays distinguishable

This gives you:
- Automatic passive capture of every command (hooks)
- Agent-initiated markers and scope checks (MCP)
- Team-shared scope configuration (profiles)
- Per-operator attribution + Bitcoin-backed integrity anchoring
