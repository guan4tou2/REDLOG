# RedLog AI Agent Integration

RedLog exposes its full functionality to AI agents via three integration layers:

## 1. MCP Server (Recommended for Claude Code / Cursor)

The MCP server auto-discovers a running RedLog instance and exposes 12 tools.

### Setup

```bash
# Claude Code
claude mcp add redlog -- node /path/to/redlog/mcp/redlog-mcp-server.js

# Or in .claude/settings.json
{
  "mcpServers": {
    "redlog": {
      "command": "node",
      "args": ["/path/to/redlog/mcp/redlog-mcp-server.js"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `redlog_status` | IP/VPN state, event count, scope violations |
| `redlog_mark` | Create a timestamped marker (finding, phase change, note) |
| `redlog_log_event` | Log a raw event with custom type and data |
| `redlog_search` | Full-text search across all events |
| `redlog_events` | Query recent events by type/target |
| `redlog_scope` | Get scope config and violations |
| `redlog_config` | Get project configuration |
| `redlog_quickmark` | Create a bookmark for a URL/finding |
| `redlog_quickmarks_list` | List all bookmarks |
| `redlog_loot_scan` | Scan text for credentials/secrets |
| `redlog_screenshot` | Capture desktop screenshot |
| `redlog_recording` | Pause/resume/toggle recording |

### Example Usage in Claude Code

When RedLog MCP is connected, you can say:
- "Mark this as a critical SQLi finding on api.example.com"
- "Search RedLog for any commands targeting port 443"
- "Show me the current scope and any violations"
- "Scan this output for leaked credentials"

## 2. HTTP API (For scripts and non-MCP agents)

RedLog runs an HTTP API on `127.0.0.1:6660` with Bearer token auth.

### Auth

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status
```

### Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/status` | System status |
| GET | `/api/config` | Project configuration |
| GET | `/api/scope` | Scope targets and violations |
| GET | `/api/recording` | Recording state |
| POST | `/api/recording` | Control recording (`{"action":"pause\|resume\|toggle"}`) |
| POST | `/api/events` | Insert event |
| GET | `/api/events` | Query events (`?agent_type=&limit=&target_id=`) |
| GET | `/api/events/search` | Search events (`?q=&limit=`) |
| GET | `/api/events/count` | Event count |
| POST | `/api/marker` | Create marker |
| GET | `/api/quickmarks` | List bookmarks |
| POST | `/api/quickmarks` | Create bookmark |
| POST | `/api/loot/scan` | Scan for secrets |
| POST | `/api/screenshot` | Capture screenshot |

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

## 3. Shell Hook (For bash/zsh scripts)

```bash
source /path/to/redlog/shell/redlog-agent.sh

# Create a marker
redlog_mark "Found SQLi on login endpoint" "Time-based blind" "high"

# Log a raw event
redlog_event "agent" '{"subtype":"scan_complete","target":"example.com","findings":3}'

# Quick note
redlog_note "Switching to manual testing for auth bypass"

# Check status
redlog_status
```

## 4. CLI (For any environment)

```bash
# Log events
redlog-cli log agent --data '{"subtype":"recon","target":"example.com"}'

# Create markers
redlog-cli mark "Found IDOR in /api/users/123" --severity high --target api.example.com

# Search
redlog-cli search "password" --limit 10

# Scan for loot
redlog-cli loot "root:x:0:0:root:/root:/bin/bash"

# Get status
redlog-cli status
```

## Codex / OpenAI Function Calling

See `docs/codex-tools.json` for OpenAI-compatible function definitions
that can be used with Codex, GPT, or any OpenAI-API-compatible model.

## Building a Custom Agent Skill

To create a Claude Code skill that uses RedLog:

```markdown
# .claude/skills/pentest-logger.md

When performing security testing, log all findings to RedLog:

1. At session start: call `redlog_status` to verify connection
2. Before scanning: call `redlog_config` to check scope
3. When finding something: call `redlog_mark` with severity
4. After scanning: call `redlog_log_event` with results summary
5. For interesting URLs: call `redlog_quickmark`
```

## Config Profile Sharing

Export your project config for team sync:

```bash
# In RedLog UI: Settings → Data → Export Profile
# Produces a .yaml file like:

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

Team members import this when creating a new project (Project Picker → Advanced Setup → Import Profile).
