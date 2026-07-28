# RedLog

Red Team Operator Workbench — an Electron desktop app that passively records everything during a penetration test engagement into a tamper-evident, per-project timeline database.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Passive Recording** — automatically captures terminal commands, clipboard, screenshots, file transfers, and network events
- **Pause / Resume** — click the status bar recording indicator to pause event capture; click again to resume
- **7-Lane Swim Timeline** — shell, screenshot, clipboard, file transfer, marker, loot, system — with dynamic lane height and real-time event dots
- **Evidence Chain** — append-only chain of event IDs for tamper evidence
- **Scope Monitor** — target scope enforcement with DNS query logging
- **Loot Detector** — regex-based credential/secret scanning (AWS keys, JWTs, password hashes, flags, etc.)
- **Screenshot Agent** — idle-triggered capture with 2-tier dedup (SHA-256 + pixelmatch)
- **HTTP API** — localhost REST API for external tool integration (127.0.0.1 only, Bearer token auth)
- **CLI Tool** — `redlog-cli` for shell script and agent integration
- **i18n** — English and Traditional Chinese (zh-TW)
- **IP Overlay** — always-on-top floating widget showing external/internal IP
- **Per-Project Isolation** — each engagement has its own config, database, screenshots, and terminal recordings

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
  +-- EventBus              pub/sub with pause/resume support
  +-- Services
  |     +-- IPMonitor         external IP polling, VPN status detection
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
  +-- Dashboard             stats + engagement info + keyboard shortcuts
  +-- Timeline              custom swim-lane timeline (7 lanes, dynamic height)
  +-- ScreenshotsView       thumbnail grid with lightbox
  +-- TargetView            auto-cataloged targets with evidence drilldown
  +-- ScopeStatus           violation log
  +-- LootPanel             detected credentials/secrets
  +-- SearchPanel           full-text search across all events
  +-- Settings              YAML config editor
  +-- StatusBar             recording toggle + VPN/scope/loot/uptime indicators
  +-- ErrorBoundary         per-view crash recovery

Overlay Window
  +-- IP status always-on-top widget (top-right corner)
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
      findings.ts            QuickMarks CRUD
    services/
      api-server.ts          HTTP API (localhost:6660)
      clipboard-monitor.ts   clipboard polling + redaction
      config.ts              YAML config load/save
      event-bus.ts           EventEmitter pub/sub with pause/resume
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
      i18n/                  en.json + zh-TW.json locale files
      styles/index.css       Tailwind + custom scrollbar
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
| agent_type | TEXT | shell, screenshot, clipboard, file_transfer, marker, loot, system |
| hostname | TEXT | Machine hostname |
| source_ip | TEXT | Source IP (nullable) |
| target_id | TEXT | Auto-detected target (nullable) |
| data | TEXT | JSON payload (varies by agent_type) |
| hash | TEXT | SHA-256 of event content |
| created_at | INTEGER | Unix ms |

### Per-project directory

```
~/.redlog/projects/<id>/
  config.yaml          engagement config
  timeline.db          SQLite database
  screenshots/         JPEG captures
  terminal/            asciicast v2 recordings (.cast)
```

## HTTP API

The API server starts when a project is opened (default port 6660, 127.0.0.1 only).

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status
```

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/events | Insert an event |
| GET | /api/events | Query events (filter by agent_type, target_id, limit, since) |
| GET | /api/events/search?q=...&limit=N | Full-text search |
| GET | /api/events/count | Event count |
| POST | /api/marker | Create a marker event |
| POST | /api/loot/scan | Scan text for credentials |
| POST | /api/screenshot | Trigger manual capture |
| GET | /api/status | IP status, event count, violations |
| GET | /api/health | Health check (no auth) |

## CLI

```bash
redlog-cli mark "Found SQLi in /api/users" --severity high --target api.example.com
redlog-cli log terminal --data '{"subtype":"command","command":"nmap -sV 10.0.0.1"}'
redlog-cli search "password" --limit 20
redlog-cli events --agent_type terminal --limit 10
redlog-cli loot "root:$6$...:..."
redlog-cli screenshot
redlog-cli status
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Cmd+1..8 | Switch views |
| Cmd+Shift+M | Quick marker |
| Cmd+/ | Search |

## Configuration

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

Changes are hot-reloaded — no restart needed.

## Security Model

- **Sandbox**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- **contextBridge**: explicit API surface — renderer cannot access Node.js
- **Path validation**: screenshot reads validated within project directory
- **Clipboard redaction**: passwords, API keys, private keys auto-redacted
- **API auth**: Bearer token (random 32 bytes), file permission 0600
- **API binding**: 127.0.0.1 only — not exposed to network

## Tech Stack

- **Runtime**: Electron 33 + electron-vite
- **Database**: better-sqlite3 (WAL mode)
- **UI**: React 18 + Tailwind CSS 3
- **Timeline**: Custom HTML/CSS swim-lane (zero dependencies)
- **Screenshot dedup**: pixelmatch + pngjs
- **DNS logging**: dns2
- **Config**: js-yaml
- **i18n**: Custom React context

## License

MIT
