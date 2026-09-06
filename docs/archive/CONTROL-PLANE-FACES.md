# Control-Plane Faces — one implementation, many thin adapters

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to RedLog's control plane
(DESIGN-PRINCIPLES §7). This subsystem decomposes **differently** from plugins and
detectors, and that difference is itself instructive: every face does the *same*
shape of work (adapt the canonical op set to a transport), so the closed set that
matters is not "N roles" but **the canonical op catalog + a single Adapter role**.

## The method, adapted

For plugins/detectors the mechanism axis produced *several* roles (different shapes
of work). Here every face is structurally identical — a thin adapter. So:

- **The closed set = the canonical op catalog** (the evidence-relevant control ops).
- **The single role = Adapter** (project a subset of ops onto a transport, adding
  only serialization + auth, never logic).
- **Faces are then *classified*** along transport × audience × generation — a
  catalog, not a role zoo.

This is the "one role + canonical catalog" variant of the method (see
`DECOMPOSITION-METHOD.md`).

## The canonical layer (what everything adapts)

§7 names "the localhost REST handlers" as canonical, but structurally the true
canonical implementation is **the core op modules** (`insertEvent`, `searchEvents`,
the chain ops, scope/loot reads). **REST is itself an adapter** over those — the
first and most privileged one, but not the source of truth. Naming the core (not
REST) as canonical is what lets MCP, IPC, CLI, and the Codex schema all be *peer*
adapters that cannot drift from each other, because none is defined in terms of
another.

## The canonical op catalog (closed, §7 "evidence-relevant only")

Grouped by §7's three purposes:

| Group | Ops | Source |
|---|---|---|
| **Write evidence** | `mark`, `quickmark`, `log_event` | `api-server` L125/L136/L169 |
| **Operate chain / recording** | `chain_status`, `chain_anchor_now`, `chain_verify`, `chain_upgrade`, `recording` (pause/resume) | L199–208, L191 |
| **Read for decisions** | `status`, `whoami`, `operators_list`, `scope`, `search`, `events`, `config`, `loot_scan`, `screenshot`, `quickmarks_list` | L111–185 |

**Boundary (§7):** the catalog is *evidence-relevant control* only. It **never
duplicates capture** (hooks own that) and **never grows evidence-irrelevant ops**.
Delivery ops (`export/bundle`, `sanitize`, `deconfliction`, `anchors`) that appear
on REST belong to the **Delivery** subsystem (next candidate), not the control
catalog — see Gaps.

## The Adapter role (the contract every face fills)

- **Declares:** transport, audience, the op-subset it exposes, auth model,
  serialization.
- **Contains:** no logic. It marshals a request into a canonical op call and
  marshals the result back. **A face that makes a decision is a bug** — that is the
  §7 failure mode, and the review test for any face change.
- **Test seam:** given a mocked canonical op layer, assert the adapter calls the
  right op with the right args and serializes the result — no behaviour of its own
  to test beyond marshalling.

## Face classification (transport × audience × generation)

| Face | Transport | Audience | Generation | Op coverage | Source |
|---|---|---|---|---|---|
| **REST** | HTTP `/api/*` | scripts / CLI backend | canonical hand-written | full | `src/core/api-server.ts` |
| **MCP** | JSON-RPC over HTTP `/mcp` + stdio bridge | AI agents | mirrored (18 `redlog_*` tools) | full control catalog | `api-server` L111–208, `mcp-tools.ts` |
| **Renderer IPC** | Electron IPC (`window.redlog`) | operator UI | native | UI-relevant subset | `src/main` ↔ `src/preload` |
| **CLI** | shells out to REST | humans / scripts | thin wrapper | partial (events, marker, search) | `cli/redlog-cli.js` |
| **Shell helpers** | source into `.zshrc`; curl REST | human shell | thin wrapper | quick ops | `shell/redlog-agent.sh` |
| **Codex schema** | static JSON function schema | external GPT/codegen | mirrors MCP (18) | full control catalog | `docs/codex-tools.json` |

## Gaps this framework surfaces

| # | Gap | Why it matters | Fix |
|---|---|---|---|
| 1 | Is MCP a thin adapter over the *same* canonical ops as REST, or a **parallel `switch`**? | If parallel, the two can drift — the exact §7 risk | verify both dispatch into one shared op layer (the core modules); if not, extract it |
| 2 | `codex-tools.json` is hand-maintained but must equal the MCP surface | §7 wants faces "ideally generated" — hand-sync drifts | **generate** the Codex schema from the MCP tool registry |
| 3 | REST mixes control ops with **delivery ops** (`export/bundle`, `sanitize`, `deconfliction`, `anchors`) | blurs the §7 "evidence-relevant control only" boundary | move delivery ops to the Delivery subsystem's face; keep the control catalog minimal |
| 4 | CLI covers only a subset of ops | fine if intentional, opaque if not | declare the CLI's op-subset explicitly (part of the Adapter contract) |
| 5 | No single place lists the canonical catalog | new faces guess the op set | this doc's catalog table is the source; keep it in sync with the tool registry |

## Why this decomposition pays

- **Adding an integration surface** (a new agent client, a new script transport)
  becomes "fill the Adapter contract for these ops on this transport" — no design.
- **Drift becomes detectable:** any face exposing an op not in the catalog, or
  containing logic, fails the contract on review.
- **§7 stops being a slogan:** "one implementation, many thin faces" is now a
  catalog + a contract you can check a diff against.

## Cross-references

- The method + variants: `DECOMPOSITION-METHOD.md`
- The principle: `DESIGN-PRINCIPLES.md` §7
- The full agent surface (transports, setup): `agent-integration.md`
- Next candidate that owns the delivery ops split out here: Delivery / export targets
