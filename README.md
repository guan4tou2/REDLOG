# RedLog

Red Team Operator Workbench -- an Electron-based desktop tool that passively records everything during a penetration test engagement into a tamper-evident, per-project timeline database.

## Quick Start

```bash
# Install dependencies (requires Node 20+, Python 3 for native modules)
npm install
npm run rebuild        # rebuild better-sqlite3 + node-pty for Electron

# Development
npm run dev

# Production build
npm run build
```

## Architecture

```
Electron Main Process
  +-- ProjectManager        per-engagement isolated storage (~/.redlog/projects/<id>/)
  +-- SQLite DB (WAL)       events table + evidence chain table
  +-- EventBus              pub/sub for all event producers
  +-- Services
  |     +-- IPMonitor         external IP polling, VPN status detection
  |     +-- TerminalManager   node-pty shells with asciicast recording
  |     +-- ClipboardMonitor  200ms polling, auto-redact credentials
  |     +-- ScreenshotAgent   idle-triggered capture, 2-tier dedup (SHA-256 + pixelmatch)
  |     +-- ScopeMonitor      target scope check + DNS query logging (UDP :15353)
  |     +-- LootDetector      regex-based credential/secret scanning
  |     +-- FileTransferTracker   ~/Downloads watcher with auto-hash
  |     +-- EvidenceChain     append-only chain of event IDs
  |     +-- APIServer         localhost HTTP API for external agents
  +-- IPC (contextBridge)   renderer <-> main communication

Renderer (React 18 + Tailwind CSS 3)
  +-- ProjectPicker         project create/open/delete
  +-- Sidebar               navigation with live badges
  +-- Dashboard             stats + engagement info
  +-- Terminal              multi-tab xterm.js with split timeline
  +-- Timeline              vis-timeline swimlane (7 lanes)
  +-- ScreenshotsView       thumbnail grid with lightbox
  +-- TargetView            auto-cataloged targets with evidence drilldown
  +-- ScopeStatus           violation log
  +-- LootPanel             detected credentials/secrets
  +-- SearchPanel           full-text search across all events
  +-- ReportExport          JSON/CSV/Markdown export
  +-- Settings              YAML config editor
  +-- StatusBar             VPN/scope/loot/uptime indicators
  +-- ErrorBoundary         per-view crash recovery

Overlay Window
  +-- IP status always-on-top widget (top-right corner)

CLI
  +-- redlog-cli            shell tool for external agent integration
```

## Project Structure

```
src/
  main/
    index.ts                 app entry, IPC handlers, service lifecycle
    windows.ts               BrowserWindow creation (main + overlay)
    tray.ts                  system tray menu
    db/
      index.ts               SQLite init, schema, WAL mode
      events.ts              insert/query/search events
    agents/
      terminal-manager.ts    PTY session management + asciicast recording
    services/
      api-server.ts          HTTP API (localhost:6660)
      clipboard-monitor.ts   clipboard polling + redaction
      config.ts              YAML config load/save
      event-bus.ts           EventEmitter pub/sub
      evidence-chain.ts      append-only event chain
      file-transfer-tracker.ts  fs.watch on ~/Downloads
      ip-monitor.ts          external IP check + VPN detection
      loot-detector.ts       credential/secret pattern matching
      project-manager.ts     per-project directory management
      scope-monitor.ts       scope enforcement + DNS server
      screenshot-agent.ts    screen capture + dedup pipeline
      target-extractor.ts    command parser for target/transfer detection
  preload/
    index.ts                 contextBridge API for main window
    overlay.ts               contextBridge API for overlay
  renderer/
    src/
      App.tsx                main app layout + routing
      OverlayApp.tsx         IP overlay widget
      components/            all UI components
      styles/index.css       Tailwind + vis-timeline dark theme
      env.d.ts               TypeScript declarations for preload API
cli/
  redlog-cli.js             CLI tool for external integration
```

## Data Model

All data is stored in SQLite (`~/.redlog/projects/<id>/timeline.db`):

### events table

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | UUID |
| timestamp | INTEGER | Unix ms |
| engagement_id | TEXT | Engagement identifier |
| session_id | TEXT | App session UUID |
| operator_id | TEXT | Operator identifier |
| agent_type | TEXT | terminal, screenshot, clipboard, file_transfer, marker, loot, system |
| hostname | TEXT | Machine hostname |
| source_ip | TEXT | Source IP (nullable) |
| target_id | TEXT | Auto-detected target (nullable) |
| data | TEXT | JSON payload (varies by agent_type) |
| hash | TEXT | SHA-256 of event content |
| created_at | INTEGER | Unix ms |

### chain table

Append-only evidence chain linking event IDs in order.

### Per-project directory

```
~/.redlog/projects/<id>/
  config.yaml          engagement config
  timeline.db          SQLite database
  screenshots/         JPEG captures
  terminal/            asciicast v2 recordings (.cast)
```

## Security Model

- **Sandbox**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- **contextBridge**: explicit API surface -- renderer cannot access Node.js
- **Path validation**: screenshot:read validates paths are within project screenshots/
- **Clipboard redaction**: passwords, API keys, private keys auto-redacted before storage
- **API auth**: Bearer token (random 32 bytes), file permission 0600
- **API binding**: 127.0.0.1 only -- not exposed to network

## HTTP API

The API server starts when a project is opened. Token and port are auto-written to `~/.redlog/`.

### Authentication

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)    # default 6660
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status
```

### Endpoints

#### POST /api/events
Insert an event.

```bash
curl -X POST http://127.0.0.1:6660/api/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_type": "terminal", "data": {"subtype": "command", "command": "nmap -sV 10.0.0.1"}, "target_id": "10.0.0.1"}'
```

#### GET /api/events
Query events.

| Param | Description |
|---|---|
| agent_type | Filter by type |
| target_id | Filter by target |
| limit | Max results (default 100) |
| since | Unix ms timestamp |

#### GET /api/events/search?q=...&limit=N
Full-text search across event data, target_id, agent_type.

#### GET /api/events/count
Returns `{count: N}`.

#### POST /api/marker
Create a marker event.

```bash
curl -X POST http://127.0.0.1:6660/api/marker \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Found SQLi", "severity": "high", "target_id": "api.example.com"}'
```

#### POST /api/loot/scan
Scan text for credentials/secrets.

```bash
curl -X POST http://127.0.0.1:6660/api/loot/scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "password=hunter2\nAKIA1234567890ABCDEF"}'
```

#### POST /api/screenshot
Trigger a manual screenshot capture.

#### GET /api/status
Returns IP status, event count, scope violations.

#### GET /api/health
Health check (no auth required). Returns `{ok: true, version: "0.1.0"}`.

## CLI

```bash
# Install globally
cd redlog && npm link

# Or run directly
node cli/redlog-cli.js <command>
```

### Commands

```bash
# Record an event
redlog-cli log terminal --data '{"subtype":"command","command":"nmap -sV 10.0.0.1"}' --target 10.0.0.1

# Create a marker
redlog-cli mark "Found SQLi in /api/users" --severity high --target api.example.com

# Search events
redlog-cli search "password" --limit 20

# List recent events
redlog-cli events --agent_type terminal --limit 10

# Scan for loot
redlog-cli loot "root:x:0:0:root:/root:/bin/bash"

# Trigger screenshot
redlog-cli screenshot

# Check status
redlog-cli status

# Health check
redlog-cli health

# Print token (for curl)
curl -H "Authorization: Bearer $(redlog-cli token)" http://127.0.0.1:6660/api/events
```

## Agent Integration Examples

### Claude Code MCP

```bash
# In a Claude Code session, log findings directly to RedLog:
redlog-cli mark "IDOR on /api/v2/users/{id}" --severity high --target api.target.com
redlog-cli log external --data '{"subtype":"finding","title":"IDOR","cvss":7.5}'
```

### Shell Script

```bash
#!/bin/bash
# Auto-log nmap results to RedLog
TARGET=$1
nmap -sV $TARGET -oN /tmp/nmap.txt
redlog-cli log terminal --data "{\"subtype\":\"command\",\"command\":\"nmap -sV $TARGET\"}" --target $TARGET
redlog-cli mark "Nmap scan complete: $TARGET" --severity info --target $TARGET
```

### Python

```python
import requests, json

TOKEN = open(os.path.expanduser("~/.redlog/api-token")).read().strip()
PORT = int(open(os.path.expanduser("~/.redlog/api-port")).read().strip())

def redlog_event(agent_type, data, target=None):
    requests.post(f"http://127.0.0.1:{PORT}/api/events",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"agent_type": agent_type, "data": data, "target_id": target})

redlog_event("external", {"subtype": "scan", "tool": "nuclei", "findings": 3}, "target.com")
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Cmd+1..9 | Switch views (Dashboard, Terminal, Timeline, ...) |
| Cmd+Shift+M | Quick marker |
| Cmd+/ | Search |

## Configuration

Copy `config.example.yaml` to your project directory and edit:

```yaml
engagement:
  id: pentest-2026-001
  name: "Example Corp External Pentest"
operator:
  id: op-1
  name: "Operator"
network:
  vpnIPs: ["203.0.113.42"]
  dailyIPs: ["114.24.97.0/24"]
  checkInterval: 10
scope:
  enforcement: warn    # warn | log
  targets: ["*.example.com", "10.0.0.0/8"]
  excludeTargets: ["10.0.0.1"]
```

Changes saved in Settings are applied immediately (hot-reload) -- no restart needed.

## Detected Loot Patterns

| Type | Example |
|---|---|
| password_hash | $6$rounds=5000$... |
| ntlm_hash | aad3b435...:31d6cfe0... |
| private_key | -----BEGIN RSA PRIVATE KEY----- |
| aws_key | AKIA1234567890ABCDEF |
| jwt | eyJhbG... |
| database_url | postgres://user:pass@host/db |
| shadow_entry | root:$6$...:... |
| flag | flag{...}, HTB{...} |
| base64_creds | Authorization: Basic ... |
| generic_api_key | api_key=sk-... |

## Supported Target Detection

Commands automatically parsed for target extraction:

ssh, scp, rsync, nmap, masscan, rustscan, curl, wget, httpie, sqlmap, ffuf, gobuster, feroxbuster, dirb, nikto, wpscan, nuclei, hydra, crackmapexec/netexec, evil-winrm, impacket, nc/ncat/socat, ping, traceroute, dig, ldapsearch, bloodhound, Metasploit `set RHOSTS`

## Tech Stack

- **Runtime**: Electron 33 + electron-vite
- **Database**: better-sqlite3 (WAL mode)
- **Terminal**: node-pty + @xterm/xterm
- **UI**: React 18 + Tailwind CSS 3
- **Timeline**: vis-timeline + vis-data
- **Screenshot dedup**: pixelmatch + pngjs
- **DNS logging**: dns2
- **Config**: js-yaml

## Not Yet Implemented

- Encrypted database (better-sqlite3-multiple-ciphers)
- Shipper Agent (Elasticsearch/SIEM export)
- Plugin system (manifest + dynamic loading)
- Session health monitoring plugin

## License

Private -- internal use only.
