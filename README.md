# RedLog

Red Team Operation Log — an Electron desktop app that passively records everything during a penetration test engagement into a tamper-evident, per-project timeline database.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
[![Latest release](https://img.shields.io/github/v/release/guan4tou2/REDLOG?label=download&logo=github)](https://github.com/guan4tou2/REDLOG/releases/latest)

## Download

Grab the latest installer from the [**releases page**](https://github.com/guan4tou2/REDLOG/releases/latest) — current version **v0.6.65**:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | [`RedLog-0.6.65-arm64.dmg`](https://github.com/guan4tou2/REDLOG/releases/download/v0.6.65/RedLog-0.6.65-arm64.dmg) |
| macOS (Intel) | [`RedLog-0.6.65.dmg`](https://github.com/guan4tou2/REDLOG/releases/download/v0.6.65/RedLog-0.6.65.dmg) |
| Windows (installer) | [`RedLog.Setup.0.6.65.exe`](https://github.com/guan4tou2/REDLOG/releases/download/v0.6.65/RedLog.Setup.0.6.65.exe) |
| Windows (portable) | [`RedLog.0.6.65.exe`](https://github.com/guan4tou2/REDLOG/releases/download/v0.6.65/RedLog.0.6.65.exe) |

Builds are unsigned. On macOS, right-click the app → **Open** on first launch to get past Gatekeeper; on Windows, click **More info → Run anyway** past SmartScreen.

## Why RedLog

Penetration testers need a complete, tamper-evident record of every action taken during an engagement. RedLog runs in the background and captures terminal commands, clipboard activity, screenshots, file transfers, and network events — all timestamped and indexed in a per-project SQLite database. No manual note-taking required.

**Key differentiators:**

- **Zero-friction capture** — installs, starts recording, stays out of your way
- **AI agent native** — MCP server + shell hooks let Claude Code, Codex, and GPT log directly into your timeline
- **Scope-aware** — root-domain matching alerts you when tools touch out-of-scope targets without false positives on unrelated hosts
- **Per-operator identity** — every event carries an operator id resolved from an API token; teammates and agents get their own tokens ([details](docs/operators.md))
- **Evidence chain + OpenTimestamps** — append-only SHA-256 chain, hourly anchored to public OpenTimestamps calendars, one-command `.ots` bundle export for third-party `ots verify` ([details](docs/audit-trail.md))
- **Ghostwriter-compatible event schema** — first-class `dns`, `credential_use`, `c2_checkin`, `file_transfer` types plus standard `dest_ip / dest_host / mitre_ttp / description` keys ([details](docs/event-schema.md))
- **Signed evidence bundle** — `redlog-cli export bundle` produces a self-contained directory with SHA-256 manifest ready for delivery
- **Entropy-based redaction** — high-entropy tokens and per-project allow/denylist patterns are auto-redacted from captured output
- **Clock hardening** — every event carries wall-clock, monotonic, and NTP offset
- **Deconfliction webhook** — optional signed feed to the blue team's SOC on marker / scope-violation / cred-use events ([details](docs/deconfliction.md))
- **asciinema terminal recording** — every RedLog terminal pane produces a `.cast` file with SHA-256 stored on session end
- **Built-in MCP server (HTTP)** — the app hosts its own MCP endpoint, live the moment RedLog opens; agents operate the app (markers, scope, anchoring) without spawning a subprocess ([details](docs/agent-integration.md#2-mcp-server-operate-the-app))
- **One-click proxied browser** — launches Chromium through your mitmproxy with CDP enabled and a project-local profile, so captured traffic and QuickMarks work without touching your daily browser ([details](docs/agent-integration.md#proxied-browser))
- **Internal-pivot awareness** — auto-detects ligolo-ng / chisel / `ssh -D/-L/-R` / sshuttle / proxychains from shell commands and records a first-class `pivot` event (intermediate node, route, SOCKS port, MITRE T1090/T1572) so the timeline shows the lateral-movement topology ([details](docs/event-schema.md#pivot-events))
- **Extensible plugin system** — 🟢 declarative packs (loot/redaction/target patterns, event types, capture integrations) load automatically; 🔴 code plugins (agent-operable MCP tools) run in an isolated process behind a content-hash-pinned, capability-scoped trust gate ([details](docs/plugin-development.md))
- **Team sync** — export/import project config profiles so everyone starts with identical scope and settings

## Quick Start

```bash
# Install dependencies (requires Node 20+, Python 3 for native modules)
npm install
npm run rebuild        # rebuild better-sqlite3 for Electron

# Development
npm run dev

# Production build
npm run build

# Package as DMG/installer
npx electron-builder --mac    # or --win / --linux
```

> **Windows / WSL users** — see [docs/windows-setup.md](docs/windows-setup.md) for build prerequisites, PowerShell hooks, and WSL integration.

## Features

### Recording Engine

| Module | What it captures | Notes |
|--------|-----------------|-------|
| Shell hook (bash/zsh preexec) | Every command with pid, exit code, duration | Auto-installed for the built-in terminal; opt-in `source` for external shells |
| Built-in terminal (node-pty) | Terminal-pane lifecycle + asciinema `.cast` recording | SHA-256'd, size-capped (default 50 MB) |
| Pivot auto-detector | ssh -D/-L/-R, chisel, ligolo, sshuttle, proxychains, socat → structured `pivot` events | Foreground close detected via `command_end`; 30-min recency window fallback |
| Cleanup auto-detector | `history -c`, `journalctl --vacuum`, `wevtutil cl`, `shred`, `touch -t`, `chattr +i` → `cleanup` events | NIST SP 800-86 anti-forensics tracking |
| File-transfer auto-detector | `curl -o`, `wget -O`, `scp`, `rsync`, `python -m http.server` → `file_transfer` events | T1105 ingress / T1041 exfil |
| Browser CDP monitor | Every URL change in the built-in browser → `http_navigation` (T1071.001) | Filters `chrome://`, `about:`, `devtools:`, `view-source:` |
| Clipboard monitor *(opt-in)* | SHA-256 + length + line count always; loot detector runs on content; 120-char redacted preview optional | Off by default — clipboard is sensitive |
| Screenshot agent | Periodic + on-demand desktop captures | SHA-256 in event, quality configurable |
| IP monitor | External IP + safety hysteresis (safe/exposed/unknown) | `system.ip_transition` on every state or IP change |
| OPSEC state monitor | VPN interfaces (utun/tun/tap/wg/ppp/…), DNS resolvers, primary MAC, hostname | `system.opsec_state_changed` on any drift (30 s poll) |
| Scope monitor | Command targets vs allowed scope | Own `scope` lane; `warn` (violation) or `log` (silent record) enforcement |
| Loot detector | AWS keys, JWTs, tokens, password hashes, flags, PII | Regex + entropy; plugin-extensible via `lootPatterns` |
| Config diff | Security-relevant setting changes on save | `system.config_changed` with from→to diff on scope / blacklist / enforcement |
| Recording toggle | Every pause/resume | `system.recording_paused` / `recording_resumed` so timeline gaps are explainable |

### Timeline & UI

- **Swim-lane Timeline** — 15 lanes: shell, agent, http_navigation, dns, pivot, screenshot, clipboard, file_transfer, credential_use, c2_checkin, marker, loot, cleanup, scope, system. Empty lanes auto-collapse — only what this engagement touched
- **Housekeeping filter** — RedLog's own lifecycle (api_started, session_start, terminal-pane open/close, the "silent" hook auto-source) stays in the DB for the record but is hidden from the timeline
- **Command pair collapse** — a `shell.command_start` disappears once its matching `command_end` lands (same pid+cmd); still-running commands keep showing
- **Cursor-anchored zoom** — trackpad pinch and wheel zoom stay locked to what's under the cursor
- **Cluster popover** — a burst of events on one lane collapses into a dot; click to expand and jump to any event
- **Focus jumps** — clicking a loot/mark scrolls the timeline to that event and highlights it
- **Density minimap** — drag-to-zoom over a time range
- **Pause / Resume** — status-bar indicator; every toggle lands as an event so the timeline gap is explainable
- **Global Search** — full-text across all event types
- **Target View** — auto-cataloged targets with per-target evidence drill-down
- **Loot Panel** — detected credentials/secrets by type, with source (command/host) and jump-to-timeline
- **Scope Status** — violation log with enforcement mode (warn / log)
- **Screenshot Gallery** — thumbnail grid with lightbox
- **Multi-tab Terminal** — concurrent PTY sessions; asciinema recording per pane
- **Error Boundary** — per-view crash recovery

### HUD (heads-up overlay)

- **IP Widget** — always-on-top floating display: external IP (primary), internal IP + Wi-Fi/wired name, live pivot chain, recording state, capture health
- **EXPOSED alarm** — when the external IP hits the blacklist, the whole frame flashes red (toggle in Settings ▸ Overlay); default on
- **Live pivot chain** — active internal-network pivot nodes (tool · node · route); topology view shows internal → external → pivot hops
- **macOS Dock icon** — configurable (Settings ▸ Overlay); opening the HUD otherwise flips the app to accessory activation and drops the Dock icon
- **Click-through Mode** — passes mouse events through to windows below; hover to reactivate
- **Draggable** — grab the overlay to reposition
- **Menubar / tray** — red pulsing dot while recording (no text label — keeps the menu-bar compact)

### Scope Engine

RedLog's scope monitor uses root-domain matching for smart violation detection:

- **In scope**: `admin.example.com` when scope includes `*.example.com` — no alert
- **Out of scope, same root**: `staging.example.com` when scope only lists `api.example.com` — **warning**
- **Unrelated host**: `google.com` — silently ignored (no false positive)
- **IP targets**: CIDR matching with `/24`, `/16`, etc.
- **Excluded targets**: explicitly excluded IPs/hosts always flagged

### Project Management

- Per-project isolation (config, database, screenshots, terminal recordings)
- Advanced setup at creation: pre-configure scope targets, IP whitelist/blacklist, enforcement mode
- Config profile export/import (YAML or JSON) for team synchronization
- Hot-reload on config save — no restart needed

### Plugins

Trust-tiered plugin system for shop-specific patterns (see [docs/plugin-development.md](docs/plugin-development.md)):

- 🟢 **Declarative** (no code): `lootPatterns`, `redaction`, `commandTags` (stamp MITRE / custom fields onto shell events), `targetExtractors`, `eventTypes`, `capture` integrations
- 🔴 **Privileged** (code): custom MCP tools, exporters, monitors — content-hash pinned + operator consent + capability-scoped, run in an isolated utility process

RedLog ships with **no** `commandTags` installed — MITRE tagging is opinionated per shop, so either drop a plugin into `~/.redlog/plugins/` (Settings ▸ Plugins ▸ Open folder) or let your SIEM tag downstream. Hot-reload from Settings ▸ Plugins ▸ Reload.

### i18n

Built-in English and Traditional Chinese (zh-TW). Locale files in `src/renderer/src/i18n/`.

## AI Agent Integration

RedLog is designed to work alongside AI coding agents. Three integration layers — **install the hooks first and rely on them; add MCP only for what hooks can't do.** Hooks are passive so nothing can be forgotten; MCP is agent-initiated, and anything the agent forgets to log is a silent gap in the audit trail. See [Capture priority](docs/agent-integration.md#two-planes-hooks-log-mcp-operates).

### Layer 1: Terminal Hooks (Automatic Capture) — start here

Hook directly into the agent's execution shell so every command is logged without the agent needing to know about RedLog. This is the backbone of capture; set it up before anything else.

> **RedLog captures nothing until a source is wired up — being open is not enough.** Install the **shell hook** (covers commands in *your own* terminal) AND the Claude Code hook (covers only Claude Code's Bash tool). The Dashboard's **Capture Health** card warns you when nothing is feeding. See [Set up capture](docs/agent-integration.md#set-up-capture--do-this-first).

**Claude Code (PostToolUse hook):**

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "command": "/path/to/redlog/hooks/claude-code-hook.sh" }]
      }
    ]
  }
}
```

Every Bash tool call (command + output preview + session ID) is sent to RedLog's timeline.

**Any agent via shell preexec (zsh/bash):**

```bash
# Add to ~/.zshrc or ~/.bashrc
source /path/to/redlog/hooks/shell-preexec-hook.sh
```

Captures every command with start/end timestamps, exit code, and duration. Works with Claude Code, Codex, Cursor, Aider, or any tool that spawns a shell.

**Codex/GPT wrapper (for agents you can't hook):**

```bash
# Wrap the agent's shell:
SHELL=/path/to/redlog/hooks/codex-wrapper.sh codex run "scan the target"

# Or wrap a single command:
./hooks/codex-wrapper.sh nmap -sV target.com
```

### Layer 2: MCP Server (operate the app) — control plane, not logging

RedLog hosts its own MCP server **over HTTP**, so it's live whenever the app is open — no subprocess to spawn. Use it to *operate* RedLog: create markers, check scope, anchor the chain, read history. Hooks do the logging; MCP does not duplicate it.

Set up in **Settings ▸ Team & Integrations ▸ MCP Server**, then:

```bash
claude mcp add --transport http redlog http://127.0.0.1:6660/mcp \
  --header "Authorization: Bearer <mcp-token>"
```

(A stdio bridge is available as a fallback — see [docs](docs/agent-integration.md#2-mcp-server-operate-the-app).)

```bash
claude mcp add redlog -- node /path/to/redlog/mcp/redlog-mcp-server.js
```

**18 available tools (HTTP or stdio):**

| Tool | Description |
|------|-------------|
| `redlog_status` | IP state, event count, scope violations |
| `redlog_whoami` | Confirm which operator token is loaded |
| `redlog_operators_list` | List every registered operator |
| `redlog_mark` | Create a timestamped marker (finding, phase change, note) |
| `redlog_log_event` | Log a raw event with custom type and data |
| `redlog_search` | Full-text search across all events |
| `redlog_events` | Query recent events by type/target |
| `redlog_scope` | Get scope config and violations |
| `redlog_config` | Get project configuration |
| `redlog_quickmark` | Bookmark a URL/finding |
| `redlog_quickmarks_list` | List all bookmarks |
| `redlog_loot_scan` | Scan text for credentials/secrets |
| `redlog_screenshot` | Capture desktop screenshot |
| `redlog_recording` | Pause/resume/toggle recording |
| `redlog_chain_status` | Chain length + latest OTS anchor |
| `redlog_chain_anchor_now` | Anchor current chain head to OpenTimestamps |
| `redlog_chain_verify` | Fast prefix check on latest anchor |
| `redlog_chain_upgrade` | Fetch upgraded OTS proofs for pending anchors |

Ship-ready skill file at [`docs/skills/redlog-pentest.md`](docs/skills/redlog-pentest.md) — copy to `~/.claude/skills/` to opt an agent into the full flow.

**Example agent interaction:**

```
User: "Check if this target is in scope, then run a port scan and log the results"

Agent calls: redlog_scope → confirms target → runs nmap → redlog_mark with findings
```

### Layer 3: HTTP API (Universal)

Direct REST API for scripts, custom agents, and non-MCP tools.

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/api/status
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/status` | System status |
| GET | `/api/config` | Project configuration |
| GET | `/api/scope` | Scope targets + violations |
| GET | `/api/recording` | Recording state |
| POST | `/api/recording` | Control recording (`pause`/`resume`/`toggle`) |
| POST | `/api/events` | Insert event |
| GET | `/api/events` | Query events (filter by `agent_type`, `target_id`, `limit`, `since`) |
| GET | `/api/events/search` | Full-text search (`?q=...&limit=N`) |
| GET | `/api/events/count` | Event count |
| POST | `/api/marker` | Create a marker event |
| GET | `/api/quickmarks` | List bookmarks |
| POST | `/api/quickmarks` | Create bookmark |
| POST | `/api/loot/scan` | Scan text for secrets |
| POST | `/api/screenshot` | Trigger manual capture |
| GET | `/api/whoami` | Operator identity for this token |
| GET/POST/PATCH/DELETE | `/api/operators[/…]` | Operator token management |
| GET | `/api/chain` | Chain length + last anchor |
| GET/POST | `/api/anchors` | List / trigger OpenTimestamps anchoring |
| GET | `/api/anchors/verify` | Fast integrity check |

### Layer 4: Shell Functions

```bash
source /path/to/redlog/shell/redlog-agent.sh

redlog_status                           # check connection
redlog_mark "Found SQLi" "Blind" "high" # create marker
redlog_event "agent" '{"subtype":"scan_complete"}'
redlog_search "password"                # search events
redlog_scope                            # check scope
redlog_loot "root:x:0:0:..."           # scan for creds
redlog_quickmark "Interesting endpoint" "https://..."
redlog_screenshot                       # manual capture
```

### Codex / OpenAI Function Calling

See [`docs/codex-tools.json`](docs/codex-tools.json) for OpenAI-compatible function definitions usable with Codex, GPT, or any OpenAI-API-compatible model.

### More reading

- [Agent integration](docs/agent-integration.md) — full REST + MCP + hook reference
- [Operators & tokens](docs/operators.md) — multi-operator identity, token lifecycle
- [Audit trail](docs/audit-trail.md) — hash chain + OpenTimestamps + full re-walk + bundle export
- [Event schema](docs/event-schema.md) — standard agent_type + data keys (Ghostwriter-compatible)
- [Deconfliction webhook](docs/deconfliction.md) — when/how to feed the blue team
- [Plugin development](docs/plugin-development.md) — extend RedLog: 🟢 declarative packs + 🔴 trust-gated MCP tools
- [Skill: redlog-pentest](docs/skills/redlog-pentest.md) — ready-to-copy Claude Code skill

## Architecture

```
Electron Main Process
  ├── ProjectManager        per-engagement isolated storage (~/.redlog/projects/<id>/)
  ├── SQLite DB (WAL)       events table + evidence chain table
  ├── EventBus              pub/sub with pause/resume support
  └── Services
        ├── IPMonitor          external IP + safety hysteresis; emits system.ip_transition
        ├── OpsecStateMonitor  VPN/DNS/MAC/hostname drift; emits system.opsec_state_changed (30s)
        ├── ClipboardMonitor   opt-in; SHA-256 + length + loot scan; raw text never stored
        ├── ScreenshotAgent    periodic + on-demand; SHA-256 on each capture
        ├── ScopeMonitor       root-domain / CIDR matching; own `scope` timeline lane
        ├── LootDetector       regex + entropy scan; plugin-extensible via lootPatterns
        ├── CDPConnector       polls the built-in browser; emits http_navigation per URL change
        ├── CommandTagger      plugin registry for stamping MITRE / custom fields on shell events
        ├── PivotDetector      auto-detects tunnels from shell (ssh -D/-L/-R, chisel, ligolo, …)
        ├── TechniqueTagger    auto-detects cleanup (T1070) + file-transfer (T1105/T1041)
        ├── EvidenceChain      SHA-256 chain + OpenTimestamps anchor (hourly + on-demand)
        └── APIServer          localhost HTTP + MCP (18 tools) + REST

Renderer (React 18 + Tailwind CSS 3)
  ├── ProjectPicker         create (with advanced scope setup) / open / delete
  ├── Sidebar               navigation with live badges (loot, violations)
  ├── Dashboard             stats + engagement info + keyboard shortcuts
  ├── Timeline              custom swim-lane timeline (7 lanes, dynamic height)
  ├── ScreenshotsView       thumbnail grid with lightbox
  ├── TargetView            auto-cataloged targets with evidence drilldown
  ├── ScopeStatus           violation log
  ├── LootPanel             detected credentials/secrets
  ├── SearchPanel           full-text search across all events
  ├── Settings              YAML config editor + team profile sync
  ├── StatusBar             recording toggle + VPN/scope/loot/uptime indicators
  └── ErrorBoundary         per-view crash recovery

Overlay Window
  └── IP status always-on-top widget (click-through + draggable)

Hooks
  ├── claude-code-hook.sh   Claude Code PostToolUse hook
  ├── shell-preexec-hook.sh zsh/bash preexec integration
  └── codex-wrapper.sh      Shell wrapper for Codex/GPT

MCP Server
  └── redlog-mcp-server.js  12-tool MCP server (stdio transport)
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
      scope-monitor.ts       scope enforcement (root-domain matching)
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
hooks/
  claude-code-hook.sh        Claude Code PostToolUse → RedLog
  shell-preexec-hook.sh      zsh/bash preexec → RedLog
  codex-wrapper.sh           shell wrapper for any agent
mcp/
  redlog-mcp-server.js       MCP server (12 tools, stdio transport)
cli/
  redlog-cli.js              CLI tool for external integration
shell/
  redlog-agent.sh            bash/zsh helper functions
docs/
  agent-integration.md       comprehensive agent integration guide
  codex-tools.json           OpenAI function calling definitions
resources/
  icon.svg                   vector source (1024×1024)
  icon.icns                  macOS app icon
  icon-{16..1024}.png        all standard sizes
  logo.svg                   horizontal wordmark
  tray-iconTemplate.png      macOS menu bar icon
  tray-iconTemplate@2x.png   Retina variant
```

## Data Model

All data is stored in SQLite (`~/.redlog/projects/<id>/timeline.db`):

### events table

| Column | Type | Description |
|--------|------|-------------|
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

### Team Config Sync

Export your project config as a `.yaml` or `.json` profile:

1. **Export**: Settings → Team Profile Sync → Export Profile
2. **Import**: Project Picker → Advanced Setup → Import Profile, or Settings → Import Profile
3. Share the file with teammates — they import it when creating a new project

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Cmd+1..8 | Switch views |
| Cmd+Shift+M | Quick marker |
| Cmd+/ | Search |

## Security Model

- **Sandbox**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- **contextBridge**: explicit API surface — renderer cannot access Node.js
- **Path validation**: screenshot reads validated within project directory
- **Clipboard redaction**: passwords, API keys, private keys auto-redacted
- **API auth**: Bearer token (random 32 bytes), file permission 0600
- **API binding**: 127.0.0.1 only — not exposed to network

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 33 + electron-vite |
| Database | better-sqlite3 (WAL mode) |
| UI | React 18 + Tailwind CSS 3 |
| Timeline | Custom HTML/CSS swim-lane (zero dependencies) |
| Screenshot capture | electron `desktopCapturer` + SHA-256 dedup (hash-suffix key) |
| Terminal | node-pty + @xterm/xterm; asciinema `.cast` recording per pane |
| DNS logging | dns2 |
| Config | js-yaml |
| i18n | Custom React context |
| Build | electron-builder |
| AI integration | MCP (stdio) + HTTP API + shell hooks |

## Packaging

```bash
# macOS DMG
npx electron-builder --mac

# Windows installer
npx electron-builder --win

# Linux AppImage
npx electron-builder --linux
```

Built artifacts go to `dist/`.

## License

MIT
