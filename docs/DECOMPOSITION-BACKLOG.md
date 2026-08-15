# Decomposition Backlog — the gaps the framework suite surfaced

Written 2026-08-13. Consolidates the "Gaps" tables scattered across the nine
decomposition docs (`DECOMPOSITION-METHOD.md` names them all) into one prioritized,
**deduplicated** backlog. The dedup matters: because the frameworks interlock, many
gaps are *the same underlying work seen from different docs* — so ~30 gap rows
collapse into a handful of keystones. Each item notes: what, which docs surfaced
it, code vs doc/example, what it unblocks / depends on, and whether it touches
another session's active territory (coordinate before editing).

> **Status (updated 2026-08-14):** no longer accurate as written — parts of K1 and
> K2 have shipped (see the ✅ marks below and `git log`). Treat this as a planning
> doc, **not** a shipped-state tracker: verify against code before relying on any
> row. Items marked
> ⚠️ touch files other sessions are actively editing (`Timeline.tsx`,
> `Settings.tsx`, `retention.ts`, `plugins/types.ts`) — coordinate first.

## Keystones (do first — each unblocks several other gaps)

### K1 — The §3 inferred-`detection` primitive  ⚠️ (plugins/types.ts, renderer)
The single highest-leverage item. Surfaced **four times**: `PLUGIN-ROLES` gap #3,
`DETECTOR-ROLES` gap #3, `EVENT-TYPE-VOCABULARY` gap #2, `TIMELINE-ELEMENTS` G4.
- Define a shared **inferred-`detection` event shape** — confidence, detector
  attribution, one-click promote-to-marker. **Still open.** Note `authority` and
  `confidence` turned out to be **orthogonal axes**, not one field: authority is
  two-valued and decides rendering + forwarding; confidence grades an inference
  and is meaningless on a fact. `plugins/types.ts` already exports `Confidence`;
  `core/authority.ts` owns the other axis. Do not merge them.
- ✅ **Add `authority: 'fact' | 'inferred'` to `EventTypeDef`** — done, plus
  `EventTypeContribution.authority` for plugins, a built-in default table, and
  per-event override precedence (`core/authority.ts`). `insertEvent` stamps
  `inferred` into the **hashed** row, so the label cannot be stripped without
  breaking the chain; absence means `fact`.
- 🟡 **Solid-vs-dashed wired to `authority`** — done for timeline event dots
  (`lib/dotShape.ts`) and already done for the phase ribbon. Other timeline
  elements and the one-click promote flow beyond phase are still open.
- **Unblocks:** plugin Labeller role, semantic injection labels (K2/K3), timeline
  honesty (G4), detector suggestions rendering as promotable. **Code.**

### K2 — Off-chain content unification  ⚠️ (retention.ts, new store module)
Surfaced across `OFF-CHAIN-CONTENT-STORES` (gaps 1–6) + `SPEC-SCOPE-AWARE-LIFECYCLE`
(G1–G2). ~~The keystone inside it: **io_ref is spec-only, never implemented**.~~ (No longer true — `src/core/io-store.ts` shipped; re-scope this item against code.)
- Implement the **io_ref Blob store** (the keystone — no runtime code exists today).
- Wire an **io keep-window + size cap** into `config.ts` (lifecycle G1).
- Collapse the **three parallel retention branches** (`terminal.castKeepDays` +
  `screenshots.keepDays` + `agentTranscripts.keepDays`) into **one loop over a
  `contentStore.<name>` registry** (off-chain gap #2 / retention).
- Extract **one shared `isInsideDir()` traversal guard** (3 copies today) + one
  shared "bytes-match-digest / pruned≠tampered" verify.
- Route **agent-transcripts** through the Stream adapter.
- **Unblocks:** the entire lifecycle spec (compress/prune/pin needs a real store),
  scope-aware retention. **Code.**

## Quick wins (🟢 zero core change — immediate value)

### Q1 — `scan-parsers` plugin pack
`SPEC-AI-ERA-PLUGINS` gap 1 / `PLUGIN-ROLES` Parser. Bundled 🟢 pack: parse nmap
`-oX` / nuclei `-json` → typed `scanner`/`scan_result` events + `eventTypes` +
`targetExtractors`. No core change. **Doc/plugin.**

### Q2 — `mcp-tee` example + shim
`SPEC-AI-ERA-PLUGINS` gap 3 / `PLUGIN-ROLES` Tee. A stdio/HTTP-MCP proxy that
forwards to a third-party MCP server and POSTs each call. No new API — needs
`examples/plugins/mcp-tee`. **Example.**

### Q3 — pair-emit lint  ⚠️ (Settings.tsx, plugin loader)
`EVENT-TYPE-VOCABULARY` gap 1. A capture plugin emitting a new `agent_type` without
a paired `eventTypes` should **warn at load** and surface the undeclared kind in
Settings ▸ Plugins (else it lands in the "other" lane). **Code (small).**

## Unification / hygiene (real convergence, medium effort)

### U1 — Scope-aware sanitize planner
`SPEC-SCOPE-AWARE-LIFECYCLE` G3 + `DELIVERY-TARGETS` gap 5. Scope planner + `unknown`
bucket in front of `sanitize.ts`; becomes the third-party Snapshot's default
profile. Depends on scope verdict reuse (`ScopeMonitor`). **Code.**

### U2 — Named sanitize profiles across delivery
`DELIVERY-TARGETS` gap 1. Unify the three ad-hoc sanitize paths (bundle layer-4 /
cloud-share `RedactionPreview` / deconfliction subtype-filter) into named profiles
`full` / `scope-sanitized` / `filtered`, shared by all delivery targets. Overlaps U1.
**Code.**

### U3 — Control-plane face hygiene
`CONTROL-PLANE-FACES` gaps 1–5 + `DELIVERY-TARGETS` gap 2.
- Verify MCP dispatches into the **same canonical ops** as REST (not a parallel
  `switch`) — the core §7 drift risk.
- **Generate** `codex-tools.json` from the MCP tool registry (stop hand-syncing).
- Move delivery ops (`export/bundle`, `sanitize`, `deconfliction`, cloud-share)
  **off** the §7 control catalog onto a Delivery face.
- Declare the CLI's op-subset explicitly. **Code.**

### U4 — Cloud-share integrity parity
`DELIVERY-TARGETS` gap 3. Verify cloud-share carries the same Ed25519 + OTS as
`bundle-export`; make "verifiable snapshot" uniform, not per-transport. **Code (verify + maybe fix).**

## Contribution-surface growth (unblock plugin roles)

### C1 — Implement `monitors` (🔴, reserved)
`PLUGIN-ROLES` gap 1 / `SPEC-AI-ERA-PLUGINS` gap 4. Isolated 🔴 that reads the event
stream + appends inferred detections. **Depends on K1.** Unblocks semantic injection
labels + plugin Monitor path. **Code.**

### C2 — Add `detectionPatterns` (🟢)
`PLUGIN-ROLES` gap 4 / `DETECTOR-ROLES` gap 2. A 🟢 sibling of `lootPatterns` (or a
`kind` field) emitting inferred detections for the regex-detectable injection
subset. **Depends on K1.** **Code.**

### C3 — `exporters` (🔴, reserved) + plugin Stream
`PLUGIN-ROLES` gap (Exporter) / `DELIVERY-TARGETS` gap 4. Implement `exporters` (first
instance = scope-sanitized bundle, U1); add a gated plugin Stream for SIEM/blue-team
forwarders. **Code.**

### C4 — User-plugin `tailers` isolation
`PLUGIN-ROLES` Tailer (bundled-only today) / `CAPTURE-SOURCE-TAXONOMY`. Land the
v0.8.3+ isolation so user-authored tailers (e.g. C2 log packs) work, not just
bundled. Unblocks Q's `c2-tailers` as a user pack. **Code.**

## Small / polish

- **S1** Extractors state an explicit `confidence` field (`DETECTOR-ROLES` gap 1) —
  §3 "this is inferred" visible, not assumed. **Code (small).**
- **S2** Generalize the Correlator (`DETECTOR-ROLES` gap 5) — declare linker-field +
  relation to enable pivot→command / loot→exfil chains. **Code.**

## Already ticketed / owned elsewhere (cross-ref, don't duplicate)

- **Timeline UX** `TIMELINE-ELEMENTS` G1–G3, G5 → existing **T1/T2/T3** tickets +
  the §8 axis re-bind (redlog-91's active `SPEC-TIMELINE-AXIS` work). G4 = K1 above.
- **Plugin lifecycle UI** → **PL1** (`UX-BACKLOG-TICKETS.md`).
- **Instance-ordinal visual** (`TIMELINE-ELEMENTS` instance channel, `[proposed]`) →
  the disputed uncommitted 159-line `Timeline.tsx` change; **authorship unresolved**,
  do not touch until the owner commits it.

## Suggested order

1. **K1** (unblocks the most, and makes the timeline honest).
2. **Q1 / Q2** in parallel (zero-core, ship value immediately).
3. **K2** (unblocks the whole lifecycle).
4. **U1/U2** then **C1/C2** (need K1) ; **U3/U4** independently.
5. **C3/C4**, then **S1/S2** polish.

## Cross-references

- Where each gap came from: the nine docs indexed in `DECOMPOSITION-METHOD.md`
- Existing tickets: `UX-BACKLOG-TICKETS.md`
