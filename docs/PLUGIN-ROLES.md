# Plugin Roles — a categorization for unambiguous development

Written 2026-08-13. The classification layer above `docs/plugin-development.md`
(mechanics/trust) and `SPEC-AI-ERA-PLUGINS.md` (the four AI-era gaps). Its job:
**a developer with a capture/detection need looks up one row, and knows exactly
which contribution type, which trust tier, what event to emit, and what it costs
locally — before writing a line.**

## The one principle everything derives from

**Built-in captures the *medium* (shell / HTTP / DNS / agent tool-call / screen /
clipboard / process). A plugin performs a *role* over that medium.** So the first
question is never "what tool is this" but "**what am I doing, to which layer**"
— that answer is the role, and the role fixes the contribution and the tier.

## Two classifying axes

- **Axis 1 — what layer does it act on?** → picks the *role*.
- **Axis 2 — does it run code *inside* RedLog?** → picks the *trust tier*
  (🟢 data / out-of-process = trust-free; 🔴 in-process code = isolated,
  capability-scoped, human-approved).

## Decision tree (pick your role)

```
Are you teaching RedLog to *understand* a tool with only data/regex,
  over events it already captures?                         → RECOGNIZER   🟢
Turning a tool's *structured output file* into typed events? → PARSER     🟢
Following an *external log/stream* continuously?            → TAILER      🟢*
Sitting *between two external parties*, forwarding+recording? → TEE       🟢
*Annotating* already-captured events with a judgement?     → LABELLER   🟢/🔴
Giving an *AI agent* tools to operate RedLog?              → TOOL PROVIDER 🔴
Producing a *deliverable* from the evidence store?         → EXPORTER    🔴†
```
`*` tailers: **bundled-only today** (user-plugin tailers need isolation work,
`types.ts` L144). `†` exporters: contribution **reserved, not yet implemented**.

## Master table

| Role | Acts on | Contribution(s) | Tier | Emits | Local cost | AI-era instance |
|---|---|---|---|---|---|---|
| **Recognizer** | substrate's reading of captured events | `targetExtractors`, `commandTags`, `lootPatterns`, `redaction`, `eventTypes` | 🟢 data | tags/targets on existing events; no new event | per-event regex, negligible | recognize a new AI-tool's targets/fields |
| **Parser** | a tool's completed output file | `capture` (+`eventTypes` +`targetExtractors`) | 🟢 | typed `scanner`/`scan_result` events | one-shot parse | **Gap 1** structured scan (nmap XML, nuclei JSON) |
| **Tailer** | an external long-running log/stream | `tailers` | 🟢* | events per line/record | continuous file-follow | **Gap 2** C2 logs (Sliver, CS) |
| **Tee** | a channel between two external parties | `capture` (out-of-process proxy) | 🟢 | `agent`/`tool_call` events | one hop per call | **Gap 3** third-party MCP tee |
| **Labeller** | already-captured event stream | `detectionPatterns` (🟢, proposed) / `monitors` (🔴, reserved) | 🟢/🔴 | inferred `detection` suggestions (§3) | regex per-event / LLM call | **Gap 4** injection / hijack labels |
| **Tool provider** | RedLog itself (as MCP server) | `mcpTools` | 🔴 | tools the agent calls; events attributed to operator | RPC | RedLog-as-tool for the operator's AI |
| **Exporter** | the evidence store | `exporters` | 🔴† | a deliverable artifact | store scan | scope-sanitized bundle (see lifecycle spec) |

## Completeness — every contribution maps to exactly one role

The roles are cut along the **contribution mechanism**, not along tools, so they
are provably exhaustive over the plugin API. Every slot in `PluginContributes`
(`types.ts` L130–146) maps to a role:

| Contribution (`PluginContributes`) | Role | Tier |
|---|---|---|
| `targetExtractors` | Recognizer | 🟢 |
| `commandTags` | Recognizer | 🟢 |
| `lootPatterns` | Recognizer | 🟢 |
| `redaction` | Recognizer | 🟢 |
| `eventTypes` | Recognizer (also a Parser helper) | 🟢 |
| `capture` — parses a completed output | Parser | 🟢 |
| `capture` — forwards in-band | Tee | 🟢 |
| `tailers` | Tailer | 🟢* |
| `monitors` *(reserved)* | Labeller (semantic) | 🔴 |
| `detectionPatterns` *(proposed)* | Labeller (regex) | 🟢 |
| `mcpTools` | Tool provider | 🔴 |
| `exporters` *(reserved)* | Exporter | 🔴† |

So **7 roles cover all 10 contribution slots** (the 5 Recognizer data-contributions
collapse into one role; `capture` splits into Parser vs Tee by whether it parses a
finished artifact or forwards a live channel). Anything a plugin can express today
is one of these roles.

**The boundary (stated honestly):** the roles are complete *over the contribution
surface*, not over every imaginable need. A need that fits no contribution type is
not a plugin yet — it is an **API gap**, and the known ones are listed at the
bottom. When the surface grows, the new contribution gets a new role (or extends
one) — the framework is complete-and-extensible, not frozen. Roles are also
**for plugins only**: built-in substrate capture (the 15 medium items in
`CAPTURE-SOURCE-TAXONOMY.md`) is deliberately *not* a role.

## Cross-cutting rule — emitting roles must claim a timeline identity

The event-producing roles (**Parser, Tailer, Tee**, and a Labeller's detections)
emit events with an `agent_type`. **Each must pair with an `eventTypes`
contribution** so the event claims a timeline identity (lane / colour / glyph) and
its §3 authority — otherwise the timeline drops it into the generic "other" lane
and the plugin's evidence is illegible on the reconstruction surface. "Capture"
and "how it looks on the timeline" are one decision. See `EVENT-TYPE-VOCABULARY.md`.

---

## Per-role reference (development template)

Each role below follows the same template — **Layer · Contribution · Tier & why ·
Event contract · Local cost · Install · Test seam · Instance** — so building a new
plugin is filling in a known shape.

### 1. Recognizer 🟢 — teach the substrate, with data only

- **Layer:** the interpretation of events the substrate already captured (a shell
  command, an HTTP flow). Adds no new capture.
- **Contribution:** `targetExtractors` (pull a host from a bespoke tool's cmd),
  `commandTags` (stamp fields — MITRE, tool-category), `lootPatterns` (new secret
  format), `redaction` (allow/deny), `eventTypes` (give an `agent_type` a lane,
  colour, icon). Exact shapes: `types.ts` L45–98.
- **Tier & why:** 🟢 — pure data the app reads; loads automatically; cannot touch
  the chain. Zero trust cost, so **the long tail lives here** — most "support tool
  X" needs are a `targetExtractor` + `eventType`, nothing more.
- **Event contract:** does not emit; annotates. `targetExtractors` stamp
  `extractor_name` for audit traceability (`types.ts` L77).
- **Local cost:** regex per matching event. Negligible.
- **Install:** none — declarative, active on enable.
- **Test seam:** the pattern set is data; test the extractor/tagger as a pure
  match over sample commands.
- **AI-era instance:** recognizing a new AI-agent CLI's target/host argument, or
  tagging its subcommands with ATT&CK techniques.

### 2. Parser 🟢 — a tool's structured output → typed events

- **Layer:** a tool's *completed* structured artifact (nmap `-oX`, nuclei
  `-json`, httpx). The substrate already logged the *command*; the Parser turns
  the *result file* into typed findings.
- **Contribution:** `capture` (`CaptureContribution`, `types.ts` L100) that parses
  and POSTs, **+** `eventTypes` for the timeline identity, **+**
  `targetExtractors` for hosts/ports.
- **Tier & why:** 🟢 — an out-of-process script that POSTs to the authenticated
  local API like any client; unprivileged, can't touch the chain.
- **Event contract:** one event per host/finding —
  `agent_type: 'scanner'`, `subtype: 'scan_result'`, parsed fields (port,
  service, template-id, severity). **Severity/loot are inferred suggestions
  (§3)**, never authoritative.
- **Local cost:** parse runs once at scan completion. Output files can be large,
  but only parsed events enter the chain (raw file optionally io-sidecar'd).
- **Install:** `installMethod: 'manual'` (wrap the tool invocation) or a Tailer
  follow of the output directory. `manualSteps` carry the wrap command.
- **Test seam:** the parser is a pure `parse(rawOutput) → Event[]`; test against
  captured sample XML/JSON fixtures before it ever POSTs.
- **AI-era instance:** **Gap 1** — a bundled `scan-parsers` pack.

### 3. Tailer 🟢* — follow an external long-running channel

- **Layer:** an external channel RedLog isn't sitting on — a C2 server's log/DB,
  a scan-output directory being appended to.
- **Contribution:** `tailers` — a module exporting a `TailerAdapter`
  (`{ agentKind, transcriptGlob, … }`, `tailer-registry.ts`). The host wires it
  into `tailer-host`.
- **Tier & why:** 🟢, but **bundled-only today** — user-plugin tailers need the
  isolation work slated for v0.8.3+ (`types.ts` L144). A tailer runs continuously
  and reads an external file, so the eventual user-plugin path will be gated.
- **Event contract:** one event per line/record — e.g. `agent_type: 'scanner'`
  `subtype: 'c2_checkin'`, or `pivot` for a new route.
- **Local cost:** continuous file-follow (inotify/poll) — low but standing; the
  exposure window is the live tail, matching §2's "ambient = opt-in."
- **Install:** config the log path per tool; `manualSteps` document where each
  framework writes its log.
- **Test seam:** the adapter's line→event mapping is pure; test over recorded log
  fixtures.
- **AI-era instance:** **Gap 2** — a bundled `c2-tailers` pack.

### 4. Tee 🟢 — record a channel by sitting in-band

- **Layer:** an in-band channel between two *external* parties — the operator's AI
  client and a third-party MCP server (HexStrike, PentestMCP).
- **Contribution:** `capture` — an out-of-process proxy the client points at,
  which forwards to the real server **and** POSTs each call to RedLog.
- **Tier & why:** 🟢 — the proxy is a separate process; it can't stall RedLog and
  can't touch the chain (it POSTs like any client).
- **Event contract:** `agent_type: 'agent'`, `subtype: 'tool_call'` /
  `'tool_result'`, with tool name, input, and an output digest.
- **Distinguish from Tool provider (🔴):** a Tee **captures calls the agent makes
  to someone else's server**; a Tool provider **exposes RedLog's own tools to the
  agent**. Opposite directions — keep them named apart or they conflate.
- **Local cost:** one extra hop per tool-call — negligible interactively.
- **Install:** `manual` — repoint the AI client's MCP server URL/command at the
  tee. Note: if the client has a native tool-call hook (Claude Code
  `PostToolUse`), those calls are **already captured** — a Tee is only for
  hookless clients.
- **Test seam:** the forward-and-tee logic is testable against a mock MCP server;
  assert the emitted event equals the forwarded call.
- **AI-era instance:** **Gap 3** — needs a `examples/plugins/mcp-tee` shim (no new
  API, but no pattern exists yet).

### 5. Labeller 🟢/🔴 — annotate captured events with a judgement

- **Layer:** the *already-captured* `http`/`agent` event stream. Adds
  interpretation, not capture.
- **Contribution (two, by detectability):**
  - **Regex/heuristic** (known payload markers, canary strings): 🟢 — a
    `detectionPatterns` contribution (a **proposed** sibling of `lootPatterns`, or
    a `kind` field on it: `lootPatterns` classifies secrets, this classifies
    *behaviours*). Emits an inferred detection, not a secret.
  - **Semantic** (paraphrased injection, multi-turn goal manipulation): 🔴 — a
    `monitors` module that watches the event stream and emits inferred detections.
    **`monitors` is reserved, not yet implemented** (`types.ts` L141) — this is
    its first real use case.
- **Tier & why:** regex is data (🟢); a semantic monitor runs code and reads the
  evidence stream, which is exactly what the 🔴 trust gate exists for.
- **Event contract:** an **inferred `detection` suggestion** (§3) —
  confidence-scored, attributable to the detector, **visually distinct and
  operator-promotable** (dashed vs solid, one-click promote). Never mutates the
  source event; never authoritative.
- **Local cost:** regex per-event (cheap); a semantic monitor may call an LLM
  (latency/cost the operator opts into) — runs in the isolated utilityProcess so
  it can't block capture.
- **Install:** 🟢 pattern pack auto-loads; 🔴 monitor requires the trust gate.
- **Test seam:** regex over labelled event fixtures (real / not); for the monitor,
  a pure `classify(event) → detection|null` behind the LLM call.
- **AI-era instance:** **Gap 4** — prompt-injection / tool-call-hijack labels.

### 6. Tool provider 🔴 — expose RedLog to an AI agent

- **Layer:** RedLog itself — the plugin makes RedLog an MCP server the operator's
  agent can call.
- **Contribution:** `mcpTools` (module path). Runs in the isolated utilityProcess,
  reaches RedLog only through the capability-scoped `ctx` RPC
  (`read:events`/`write:events`/`read:findings`/`read:config`/`net:outbound`,
  `types.ts` L119).
- **Tier & why:** 🔴 — it ships and runs code; gated by content-hash-pinned
  consent (`trust.json`); changing code or requested capabilities revokes trust.
- **Event contract:** tools the agent invokes; any events appended are attributed
  to the plugin's operator (`write:events`).
- **Local cost:** RPC per call; isolated so it can't stall the host.
- **Install:** trust gate + point the agent at RedLog's MCP endpoint.
- **Test seam:** each tool is a pure function of its args + a mocked `ctx`.
- **AI-era instance:** RedLog-as-tool inside an operator's autonomous pentest agent.

### 7. Exporter 🔴† — transform the store into a deliverable

- **Layer:** the whole evidence store.
- **Contribution:** `exporters` — **reserved, not yet implemented** (`types.ts`
  L140).
- **Tier & why:** 🔴 — reads the full store (including sensitive bodies) and
  produces an external artifact; gated.
- **Event contract:** appends a chained audit event for the export action.
- **Instance:** a scope-sanitized client-deliverable exporter (see
  `SPEC-SCOPE-AWARE-LIFECYCLE.md` Part B) — its scope planner is the natural first
  Exporter.

---

## API gaps this framework surfaces (so future work is explicit)

| # | Gap | Role blocked | Fix |
|---|---|---|---|
| 1 | `monitors` reserved, unimplemented | Labeller (semantic) | implement 🔴 `monitors`: isolated read of event stream + append of inferred detections |
| 2 | no `detectionPatterns` contribution | Labeller (regex) | add sibling to `lootPatterns`, or a `kind: 'secret'\|'detection'` field |
| 3 | inferred `detection` event type absent | Labeller output | define the §3 suggestion shape (confidence, detector attribution, promote) + its dashed-vs-solid rendering |
| 4 | user-plugin `tailers` bundled-only | Tailer | land the v0.8.3+ isolation so user tailers can be trust-gated, not blocked |
| 5 | no MCP-tee pattern/example | Tee | ship `examples/plugins/mcp-tee` + a stdio/HTTP-MCP shim |
| 6 | `exporters` reserved, unimplemented | Exporter | implement 🔴 `exporters`, first instance = scope-sanitized bundle |

**Build order (from `SPEC-AI-ERA-PLUGINS.md`):** Parser + Tailer packs first (zero
core change, roles fully supported today), then Tee (shim + example), then
Labeller (grows the core API — sequence with the §3 promotion UI). Exporter tracks
the lifecycle spec.

## Cross-references

- Mechanics + trust gate: `docs/plugin-development.md`
- The four AI-era gaps in detail: `SPEC-AI-ERA-PLUGINS.md`
- Capture taxonomy + build/plugin line: `CAPTURE-SOURCE-TAXONOMY.md`
- Facts vs inferred suggestions: `DESIGN-PRINCIPLES.md` §3
- Trust-tier rationale: `redlog-plugin-system` memory
