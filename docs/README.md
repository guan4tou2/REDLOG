# RedLog Docs

Wiki-style index for **v0.3.0**. Every page is self-contained; follow the links inside each for cross-references. Downloads on the [releases page](https://github.com/guan4tou2/REDLOG/releases/latest).

## Start here

- **[Agent integration](agent-integration.md)** — the full surface: the two-plane model (hooks *log*, MCP *operates*), terminal hooks, the app-hosted MCP server (18 tools, HTTP + stdio), REST API, shell helpers, Codex function schema, the proxied browser, config profile sharing. If you're wiring an agent to RedLog, start here.

## Integrations

- **[MCP server](agent-integration.md#2-mcp-server-operate-the-app)** — RedLog hosts its own MCP endpoint over HTTP, live the moment the app opens (`http://127.0.0.1:<port>/mcp`); stdio bridge as a fallback. Set up in Settings ▸ Team & Integrations.
- **[Proxied browser](agent-integration.md#proxied-browser)** — one-click Chromium through your mitmproxy, CDP enabled, project-local profile.
- **[Deconfliction webhook](deconfliction.md)** — real-time signed feed to the blue team. When to enable, when not to, payload shape, threat model.

## Operator identity

- **[Operators & tokens](operators.md)** — how per-operator attribution works, secondary operators for teammates or agent contexts (the MCP setup mints a dedicated non-rotating `mcp-agent` token), rotate/revoke lifecycle, threat model.

## Evidence & tamper-evidence

- **[Audit trail](audit-trail.md)** — SHA-256 event chain + hourly OpenTimestamps anchoring + full re-walk verify (with wall-vs-monotonic clock-anomaly detection) + `.ots` bundle export. Threat model, what's detected, what isn't.
- **[Event schema](event-schema.md)** — standard `agent_type` values and data keys (Ghostwriter-compatible). Read before designing a new event source.

## Extending RedLog

- **[Plugin development](plugin-development.md)** — build a plugin: the manifest format, 🟢 declarative contributions (loot/redaction/target patterns, event types, capture integrations) and 🔴 privileged MCP tools, the capability-scoped `ctx` API, and the content-hash-pinned trust gate. Two worked examples under [`examples/plugins/`](../examples/plugins).

## Agent skills (drop-in)

- **[redlog-pentest](skills/redlog-pentest.md)** — Claude Code skill: hooks record, MCP operates; session start (`whoami` / `status` / `scope`), real-time findings, loot scanning, end-of-session `chain_anchor_now`. Copy to `~/.claude/skills/`.

## Project ops

- **[Releasing](releasing.md)** — two-phase cross-platform release via GitHub Actions (build matrix → single release job), plus the local `npm rebuild better-sqlite3` gotcha after packaging.

## Machine-readable

- **[codex-tools.json](codex-tools.json)** — OpenAI function-calling schema (14 functions). The MCP surface is broader (18 tools); use MCP for the full set.

## Related source

- REST + HTTP MCP server: [`src/core/api-server.ts`](../src/core/api-server.ts)
- MCP tool registry + JSON-RPC handler: [`src/core/mcp-tools.ts`](../src/core/mcp-tools.ts)
- stdio MCP bridge: [`mcp/redlog-mcp-server.js`](../mcp/redlog-mcp-server.js)
- Hooks: [`hooks/`](../hooks/) and [`shell/`](../shell/)
- Anchoring: [`src/core/chain-anchor.ts`](../src/core/chain-anchor.ts)
- Operator model: [`src/core/db/operators.ts`](../src/core/db/operators.ts)
- Browser launcher: [`src/main/services/browser-launcher.ts`](../src/main/services/browser-launcher.ts)
- IP monitor (hysteresis): [`src/core/ip-monitor.ts`](../src/core/ip-monitor.ts)
