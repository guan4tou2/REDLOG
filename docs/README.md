# RedLog Docs

Wiki-style index for **v0.9.4**. Every page is self-contained; follow the links inside each for cross-references. Downloads on the [releases page](https://github.com/guan4tou2/REDLOG/releases/latest).

## What RedLog is (and isn't)

**Core purpose:** a local audit log of a red-team engagement — recording every operator/agent action into a SHA-256 hash-chained SQLite DB, anchored hourly with OpenTimestamps, exportable as a signed evidence bundle. If it happened, RedLog captured it. If the timeline says nothing happened for 20 min, the timeline is *right* — either the operator was idle, or a `recording_paused` event is in the log.

**Not RedLog's job** (do these downstream): report writing (Ghostwriter / HackerOne / Bugcrowd formats), STIX 2.1 / VECTR / adversary-emulation-plan export, opinionated MITRE ATT&CK tagging (moved to plugins in v0.6.15 — RedLog ships with none installed, install a `commandTags` plugin or let your SIEM tag). See [plugin-development.md](plugin-development.md#commandtags--stamp-fields-onto-shell-events-when-a-pattern-matches).

## Start here

- **[Agent integration](agent-integration.md)** — the full surface: the two-plane model (hooks *log*, MCP *operates*), terminal hooks, the app-hosted MCP server (18 tools, HTTP + stdio), REST API, shell helpers, Codex function schema, the proxied browser, config profile sharing. If you're wiring an agent to RedLog, start here.

## Product & planning

- **[Design principles](DESIGN-PRINCIPLES.md)** — the durable design laws behind RedLog: evidence-core, capture-broad-sanitize-later, the two-tier attribute law (record facts, never interpretation-as-fact), two front doors, accept-but-freeze, agents-are-a-capture-source, one-implementation control plane, timeline-as-reconstruction. The yardstick every "should we build X?" answers to; positioning and roadmap elaborate it.
- **[Product positioning](PRODUCT-POSITIONING.md)** — the single source of truth for who RedLog is for (personas P1–P3 + the evidence-consumer stakeholder), the job to be done, the explicit non-goals, and where RedLog sits vs. Ghostwriter / RedEye / PwnDoc / manual oplogs. When positioning and roadmap disagree, this page wins.
- **[Architecture](ARCHITECTURE.md)** — process/layer model, startup order, DB schema and migration strategy, the capture pipeline end to end, tailer host, evidence chain, export, plugin system, IPC conventions. Replaces the stale ASCII diagram in the README.
- **[Roadmap](ROADMAP.md)** — what ships next and the v1.0 gate. Also states what is deliberately not planned.
- **[Audit 2026-08-08](AUDIT-2026-08-08.md)** — standing defect list from a full-tree review: correctness, trust-model gaps, presentation, test coverage, doc drift. Each item tagged verified/reported.
- **[UX & complexity audit 2026-08-10](UX-AUDIT-2026-08.md)** — persona-driven review of the renderer: where breadth has outrun the solo operator (Timeline 3,875 lines / Settings 2,681 lines), the first-run friction gap, and a prioritized backlog. Companion to the correctness audit above.
- **[Timeline UX deep-dive 2026-08-10](UX-TIMELINE-2026-08.md)** — the F2 deep-dive: why the timeline feels unintuitive (invisible, overloaded, context-dependent gestures), what it is *not* (lanes/data are fine), and the T1–T6 simplification plan.
- **[UX backlog — ticket specs](UX-BACKLOG-TICKETS.md)** — every finding (F1–F7, T1–T6) broken out into an independently implementable ticket: problem, proposed solution, acceptance criteria, pure test seam, effort, priority order.
- **[Timeline interaction redesign draft](DESIGN-TIMELINE-INTERACTION.md)** — concrete UI proposal with ASCII wireframes for the legend (T1), the wheel-mode decision matrix (T2), and the active-modes row (T3), plus the build order.
- **[Dev requirements — capture onboarding](DEV-REQUIREMENTS-capture-onboarding.md)** — spec + acceptance criteria for the Capture Readiness onboarding, and the red→green→integrate→cover TDD process every UX change should copy.
- **[Timeline I/O visibility](timeline-io-visibility.md)** — design note (proposed). Which sources capture input/output today, where the gaps are, and the `io_ref` sidecar + transcript-view proposal that closes them.

## Integrations

- **[MCP server](agent-integration.md#2-mcp-server-operate-the-app)** — RedLog hosts its own MCP endpoint over HTTP, live the moment the app opens (`http://127.0.0.1:<port>/mcp`); stdio bridge as a fallback. Set up in Settings ▸ Team & Integrations.
- **[Proxied browser](agent-integration.md#proxied-browser)** — one-click Chromium through your mitmproxy, CDP enabled, project-local profile.
- **[Deconfliction webhook](deconfliction.md)** — real-time signed feed to the blue team. When to enable, when not to, payload shape, threat model.

## Operator identity

- **[Operators & tokens](operators.md)** — how per-operator attribution works, secondary operators for teammates or agent contexts (the MCP setup mints a dedicated non-rotating `mcp-agent` token), rotate/revoke lifecycle, threat model.

## Capture surface

What lands on the timeline without any operator/agent action (all detailed in [event-schema.md](event-schema.md)):

- **Shell hook** (bash/zsh preexec) — every command with pid, exit, duration
- **Built-in terminal** — same, plus asciinema `.cast` recording (SHA-256'd + size-capped)
- **Pivot auto-detection** — ssh -D/-L/-R, chisel, ligolo, sshuttle, proxychains, socat → first-class `pivot` events. Foreground close detected via `command_end`; backgrounded ones drop off the HUD after 30 min of no re-detection.
- **Cleanup auto-detection** — `history -c`, `journalctl --vacuum`, `wevtutil cl`, `shred`, `touch -t`, `chattr +i` → first-class `cleanup` events (NIST SP 800-86 anti-forensics tracking)
- **File-transfer auto-detection** — `curl -o`, `wget -O`, `scp`, `rsync`, `python -m http.server` → first-class `file_transfer` events (T1105 ingress, T1041 exfil)
- **Browser navigation** — CDP-connected built-in browser writes `http_navigation` per URL change (T1071.001)
- **Clipboard** *(opt-in)* — SHA-256 + length always; loot detector runs on content; 120-char redacted preview optional
- **Screenshot agent** — periodic + on-demand, SHA-256 in event
- **IP monitor** — external IP + safety hysteresis, `system.ip_transition` on every change
- **OPSEC state monitor** — VPN interfaces, DNS resolvers, primary MAC, hostname → `system.opsec_state_changed` on any change (30 s poll)
- **Loot detector** — regex + entropy scan of shell output for credentials; plugin-extensible
- **Scope monitor** — `system.scope_violation` (own `scope` lane) when a command's target is out of scope

Drift-signals that make the log honest: `recording_paused` / `recording_resumed` (explains gaps), `config_changed` (with a from→to diff on scope / blacklist / enforcement).

## Evidence & tamper-evidence

- **[Audit trail](audit-trail.md)** — SHA-256 event chain + hourly OpenTimestamps anchoring + full re-walk verify (with wall-vs-monotonic clock-anomaly detection) + `.ots` bundle export + four-layer redaction. Threat model, what's detected, what isn't.
- **[Event schema](event-schema.md)** — standard `agent_type` values and data keys (Ghostwriter-compatible). Read before designing a new event source.
- **[Redaction design](redaction-design.md)** — design note (proposed, not yet implemented). Four-layer model: capture full → detect spans → mask in UI → sanitize on export. Why capture-time redaction is the wrong default for an evidence tool, and how the append-only chain makes deferred sanitization safe. Tracks [#6](https://github.com/guan4tou2/REDLOG/issues/6).

## Extending RedLog

- **[Plugin development](plugin-development.md)** — build a plugin: the manifest format, 🟢 declarative contributions (`lootPatterns`, `redaction`, `commandTags` for stamping MITRE/custom fields onto shell events, `targetExtractors`, `eventTypes`, `capture` integrations) and 🔴 privileged MCP tools, the capability-scoped `ctx` API, and the content-hash-pinned trust gate. RedLog ships with **no** `commandTags` — install per shop or let your SIEM tag downstream. Hot-reload via Settings ▸ Plugins ▸ Reload; drop plugin dirs into `~/.redlog/plugins/` (Open folder button).

## Agent skills (drop-in)

- **[redlog-pentest](skills/redlog-pentest.md)** — Claude Code skill: hooks record, MCP operates; session start (`whoami` / `status` / `scope`), real-time findings, loot scanning, end-of-session `chain_anchor_now`. Copy to `~/.claude/skills/`.

## Project ops

- **[Releasing](releasing.md)** — two-phase cross-platform release via GitHub Actions (build matrix → single release job), plus the local `npm rebuild better-sqlite3` gotcha after packaging.

## Machine-readable

- **[codex-tools.json](codex-tools.json)** — OpenAI function-calling schema (18 functions, matches the MCP surface).

## Related source

- REST + HTTP MCP server: [`src/core/api-server.ts`](../src/core/api-server.ts)
- MCP tool registry + JSON-RPC handler: [`src/core/mcp-tools.ts`](../src/core/mcp-tools.ts)
- stdio MCP bridge: [`mcp/redlog-mcp-server.js`](../mcp/redlog-mcp-server.js)
- Hooks: [`hooks/`](../hooks/) and [`shell/`](../shell/)
- Anchoring: [`src/core/chain-anchor.ts`](../src/core/chain-anchor.ts)
- Operator model: [`src/core/db/operators.ts`](../src/core/db/operators.ts)
- Browser launcher: [`src/main/services/browser-launcher.ts`](../src/main/services/browser-launcher.ts)
- IP monitor (hysteresis): [`src/core/ip-monitor.ts`](../src/core/ip-monitor.ts)
