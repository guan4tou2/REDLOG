# RedLog AI Agent Integration

RedLog is designed to work as a passive recorder for AI-driven penetration testing. This document covers all integration methods, from zero-config terminal hooks to full MCP control.

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

Returns current IP addresses (external/internal), VPN status, total event count, scope violation count, and recording state.

**Parameters:** none

**Returns:**
```json
{
  "ip": { "external": "203.0.113.42", "internal": "10.0.1.5" },
  "vpn": true,
  "events": 1247,
  "violations": 3,
  "recording": true
}
```

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

Create a skill that uses RedLog tools:

```markdown
# .claude/skills/pentest-logger.md

When performing security testing:

1. At session start: call `redlog_status` to verify connection
2. Before scanning: call `redlog_scope` to check target is in scope
3. When finding something: call `redlog_mark` with severity and details
4. After scanning: call `redlog_log_event` with results summary
5. For interesting URLs: call `redlog_quickmark`
6. Periodically: call `redlog_loot_scan` on command output
```

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
| GET | `/api/status` | yes | System status (IP, VPN, events, violations) |
| GET | `/api/config` | yes | Project configuration |
| GET | `/api/scope` | yes | Scope targets + violations |
| GET | `/api/recording` | yes | Recording state |
| POST | `/api/recording` | yes | Control recording (`{"action":"pause\|resume\|toggle"}`) |
| POST | `/api/events` | yes | Insert event |
| GET | `/api/events` | yes | Query events (`?agent_type=&limit=&target_id=&since=`) |
| GET | `/api/events/search` | yes | Search events (`?q=&limit=`) |
| GET | `/api/events/count` | yes | Event count |
| POST | `/api/marker` | yes | Create marker |
| GET | `/api/quickmarks` | yes | List bookmarks |
| POST | `/api/quickmarks` | yes | Create bookmark |
| POST | `/api/loot/scan` | yes | Scan for secrets |
| POST | `/api/screenshot` | yes | Trigger manual capture |

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

## Recommended Setup

For maximum coverage with minimal friction:

1. **Install shell preexec hook** in `~/.zshrc` (captures everything from all agents)
2. **Add Claude Code PostToolUse hook** (captures structured tool call data)
3. **Add MCP server** to Claude Code (lets the agent actively check scope, create markers)
4. **Create a pentest-logger skill** (guides the agent's RedLog usage)

This gives you:
- Automatic passive capture of every command (hooks)
- Agent-initiated markers and scope checks (MCP)
- Team-shared scope configuration (profiles)
