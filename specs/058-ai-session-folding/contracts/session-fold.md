# Contract: `lib/agentSessionFold`

**Feature**: 058-ai-session-folding | **Date**: 2026-09-30

RedLog exposes no network API; its contracts are the module seams that more
than one layer consumes. This feature adds one, and consumes two that exist.

---

## 1. The derivation (new)

`src/renderer/src/lib/agentSessionFold.ts`

```ts
export interface FoldParams {
  /** Events for the loaded window, already in canonical order. */
  events: readonly RedLogEvent[]
  /** Plugin-declared event types, for `toLane` resolution. */
  pluginTypes: readonly PluginEventType[]
  /** The panel's paging state: true when earlier events exist unloaded. */
  hasMore: boolean
  /** Exact action counts by session key, when a count query has resolved. */
  knownCounts?: ReadonlyMap<string, Count>
}

export function foldAgentSessions(p: FoldParams): AgentSessionFold[]

/** Which session, if any, an event was folded into. Both surfaces need this
 *  to decide whether to draw an event on its own. */
export function foldKeyOf(e: RedLogEvent, pluginTypes: readonly PluginEventType[]): string | null
```

### Guarantees

| # | Guarantee |
|---|---|
| G1 | **Pure.** No React, no DOM, no IPC, no clock read. Same input, same output. |
| G2 | **Total.** Never throws on malformed or partial input; a session it cannot interpret degrades to an unattributed fold (data-model *Degenerate session*). |
| G3 | **Partitioning.** Every agent event in `events` appears in exactly one fold's `memberIds`; no non-agent event appears in any. |
| G4 | **Order-preserving.** Turn order, and action order within a turn, follow `compareMonotonicNs`. The function does not re-sort by wall clock. |
| G5 | **Lossless.** Concatenating turns' `actionIds` reproduces member order minus prompt events. |
| G6 | **Verbatim.** `promptText` is byte-identical to the source event body. |
| G7 | **No domain re-implementation.** Performs no scope evaluation, no target identity resolution, no ordering rule of its own; reads canonical results off the events and calls `toLane` / `compareMonotonicNs`. |
| G8 | **Honest counts.** Returns `atLeast` or `unknown` per R-003; never fabricates `exact`. |

### Consumers

| Consumer | Uses | Must not |
|---|---|---|
| `TimelineEventLog.tsx` | one row per fold; `foldKeyOf` to suppress members | re-derive turns; change its own `18vh`/`22vh` sizing (FR-016) |
| `Timeline.tsx` (agent lane) | one band per fold; `foldKeyOf` to bypass `bucketByPixel` | pass agent events through pixel clustering |
| `TimelineEventInspector.tsx` | `turns` for the session detail | summarise or rewrite `promptText` |

---

## 2. Count query (existing, reused)

`window.redlog.events.count(req)` — the call `Timeline.tsx:847` already makes.
Used with a `session:` condition, whose semantics are fixed by
`docs/domain/SPEC-search-query-semantics.md:54`.

**Contract unchanged.** This feature adds no IPC channel, no new parameter and
no new preload surface. A failure resolves the fold's count to `unknown`; it
MUST NOT resolve to `0` or to the page-local number (Constitution VI).

---

## 3. Event shape consumed (existing, read-only)

The derivation depends on these fields being present as written today. They are
listed so a capture-side change that breaks the fold is caught as a contract
break rather than as a rendering bug.

| Field | Written by | Used for |
|---|---|---|
| `data.session_id` | `tailer-host.ts:587` | fold key (R-001) |
| `data.subtype` | adapters via `tailer-host` | turn boundaries (R-002), integrity states |
| `data.transcript_uuid` | `tailer-host.ts:587` | provenance display only — never grouping |
| `data.turns_emitted` on `agent.session_end` | `tailer-host.ts:1218` | authoritative turn count (R-003) |
| `agentType` | all producers | `toLane` → is this the agent lane |
| `timestamp` + monotonic fields | all producers | ordering via `compareMonotonicNs` |

**Compatibility note**: the fold treats an unknown `agent.*` subtype as a
turn-continuing action, so a new subtype added by capture degrades safely
rather than opening spurious turns.

---

## 4. What this contract deliberately does not cover

- The visual form of a band or a row — a design decision, settled in tasks
  against `docs/UIUX-STANDARD.md`, not pinned here.
- Whether agent bands share a row with shell bands (R-005, open for Phase 2).
- Any change to export, chain, search or persistence. There is none.
