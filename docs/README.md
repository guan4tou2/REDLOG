# RedLog Docs

Wiki-style index. Every page is self-contained; follow the links inside each for cross-references.

## Start here

- **[Agent integration](agent-integration.md)** — the full surface: terminal hooks, MCP server (17 tools), REST API, shell helpers, Codex function schema, config profile sharing. If you're wiring an agent to RedLog, start here.

## Operator identity

- **[Operators & tokens](operators.md)** — how per-operator attribution works, how to add secondary operators for teammates or additional agent contexts, rotate/revoke lifecycle, threat model.

## Evidence & tamper-evidence

- **[Audit trail](audit-trail.md)** — SHA-256 event chain + hourly OpenTimestamps anchoring + full re-walk verify + `.ots` bundle export. Threat model, what's detected, what isn't.
- **[Event schema](event-schema.md)** — standard `agent_type` values and data keys (Ghostwriter-compatible). Read before designing a new event source.
- **[Deconfliction webhook](deconfliction.md)** — real-time signed feed to the blue team. When to enable, when not to, payload shape, threat model.

## Agent skills (drop-in)

- **[redlog-pentest](skills/redlog-pentest.md)** — Claude Code skill covering session start (`whoami` / `status` / `scope`), real-time findings, loot scanning, and end-of-session `chain_anchor_now`. Copy to `~/.claude/skills/`.

## Machine-readable

- **[codex-tools.json](codex-tools.json)** — OpenAI function-calling schema for every RedLog tool (13 tools; primary + operator + chain).

## Related source

- REST server: [`src/core/api-server.ts`](../src/core/api-server.ts)
- MCP server: [`mcp/redlog-mcp-server.js`](../mcp/redlog-mcp-server.js)
- Hooks: [`hooks/`](../hooks/) and [`shell/`](../shell/)
- Anchoring: [`src/core/chain-anchor.ts`](../src/core/chain-anchor.ts)
- Operator model: [`src/core/db/operators.ts`](../src/core/db/operators.ts)
