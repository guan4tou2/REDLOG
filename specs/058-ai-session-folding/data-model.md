# Phase 1 Data Model: AI Session Folding

**Feature**: 058-ai-session-folding | **Date**: 2026-09-30

Everything here is a **projection**, in the sense `docs/domain/glossary.md:12`
gives the term: "Activity 是 projection，不是 DB table." No table, column,
index or migration is introduced. Each entity is computed from
`RedLogEvent[]` and holds references back to the events it was computed from
(Constitution VII, Invariant 5).

---

## Entity: `AgentSessionFold`

One agent run, folded.

| Field | Type | Source | Notes |
|---|---|---|---|
| `key` | `string` | `` `${agentKind}:${sessionId}` `` | Matches `tailer-host.ts`'s `sessionKey`. The fold's identity — R-001. |
| `agentKind` | `string` | event `agentType` producer | `claude-code` \| `codex` \| `opencode` \| plugin-supplied |
| `sessionId` | `string \| null` | `data.session_id` | `null` for pre-`session_id` events; see *Degenerate session* below |
| `startTs` | `number` | earliest loaded member's display timestamp | Ordered by `compareMonotonicNs`, never by raw wall clock |
| `endTs` | `number \| null` | `agent.session_end` timestamp | `null` while running |
| `running` | `boolean` | no `session_end` among members | State 1 of R-004 |
| `turns` | `PromptTurn[]` | derived, in order | Always ≥ 0; may begin with an unattributed turn |
| `turnCount` | `Count` | `session_end.turns_emitted` when loaded, else derived | Tri-state — see `Count` |
| `actionCount` | `Count` | member count, or a `session:` count query | Tri-state |
| `memberIds` | `string[]` | every member event id | The provenance reference. Never lossy. |
| `recordIntegrity` | `RecordIntegrity` | member subtypes | State 2 of R-004 |
| `loadState` | `'complete' \| 'edge'` | paging state at derivation time | State 3 of R-004 |
| `scopeMarkings` | `ScopeMarking[]` | canonical scope result already on members | Read, never evaluated here (Invariant 4) |
| `badges` | `EventBadge[]` | union of members' badges via `computeBadges` | Chain / evidence integrity, surfaced on the row |

**Derivation**: partition ordered events where `toLane(...) === 'agent'` by
`key`; non-agent events are never members. Ordering uses the canonical
`compareMonotonicNs` from `lib/eventOrder`.

**Degenerate session**: agent events with no `session_id` (predating the field)
fold into a single per-agent-kind group whose `sessionId` is `null` and whose
`turnCount`/`actionCount` are `exact` over what exists. It is labelled as
unattributed rather than presented as one real session.

---

## Entity: `PromptTurn`

One operator prompt and everything the agent did before the next one.

| Field | Type | Source | Notes |
|---|---|---|---|
| `ordinal` | `number \| null` | position within session, 1-based | `null` for the unattributed leading turn |
| `promptEventId` | `string \| null` | the `agent.user_message` event id | `null` only for the unattributed turn |
| `promptText` | `string \| null` | that event's body, **verbatim** | FR-004. Never paraphrased, summarised or translated. |
| `startTs` | `number` | prompt event, or session start when unattributed | |
| `endTs` | `number` | last action before the next prompt | |
| `actionIds` | `string[]` | member event ids, in order | Each opens its own event detail (FR-009) |
| `actionCount` | `number` | `actionIds.length` | Page-local by nature; the session's `Count` carries completeness |

**Boundary rule** (R-002): a turn opens at `agent.user_message` **only**.
`compact_summary`, `tool_result`, `assistant_message`, `thinking`,
`tool_interrupted`, `away_summary` and every `transcript_*` subtype continue
the current turn.

**Unattributed turn**: actions recorded before the session's first
`user_message` form a turn with `ordinal: null` shown ahead of T1 (FR-010).
They are never merged into T1, because merging would attribute actions to a
prompt with no evidence that the prompt caused them (Invariant 6).

**Numbering across a compaction**: `transcript_compacted` resets the
transcript, not the engagement. Ordinals continue; the reset is recorded on the
session, not by restarting at T1.

---

## Value: `Count` (tri-state)

```
{ state: 'exact';   value: number }
{ state: 'atLeast'; value: number }   // floor; more exist outside the loaded window
{ state: 'unknown' }                  // a count was attempted and failed
```

Required by **FR-017**; R-003 gives the rules for which state applies. Mirrors
the shape `Timeline.tsx:145` already uses for `total`
(`pending | ok | failed`). A surface MUST NOT render an `atLeast` as a plain
number, and MUST NOT render `unknown` as zero (Constitution II, VI).

`turnCount` prefers `session_end.turns_emitted` when that event is loaded, per
FR-018; see `RecordIntegrity` for what happens when the two disagree.

---

## Value: `RecordIntegrity`

```
{ complete: true }
{ complete: false; reasons: Array<'parent_missing' | 'tool_gap' | 'schema_drift' | 'turn_count_mismatch'> }
```

The first three are set from members carrying `transcript_parent_missing`,
`transcript_tool_gap` or `transcript_schema_drift`.

`turn_count_mismatch` is set when the derived turn count **exceeds**
`session_end.turns_emitted` (FR-018). Derived *below* that value is ordinary
paging and sets `loadState`, not this. The asymmetry is the point: capture
counted the whole transcript, so the derivation seeing more turns than capture
emitted means the two disagree about the same record.

A session with `complete: false` MUST say so rather than present its counts as
whole (FR-014). Distinct from `loadState` — one is a capture defect, the other
a UI boundary (R-004).

---

## Relationships

```
AgentSessionFold 1 ── * PromptTurn 1 ── * RedLogEvent (by id)
AgentSessionFold * ── 1 agent lane band      (track surface)
AgentSessionFold 1 ── 1 event-log row        (log surface)
```

Both surfaces consume the same instance; neither derives its own (FR-015).

---

## Validation rules

1. `memberIds` is a partition of the loaded agent events: every agent event
   belongs to exactly one fold, and no fold holds a non-agent event.
2. Concatenating each turn's `actionIds` in order reproduces the session's
   member order exactly, minus the prompt events themselves. No member is
   dropped by folding.
3. `promptText` is byte-identical to the source event's body.
4. A fold reports no scope state that its members do not carry.
5. Total events, out-of-scope count and export contents are unchanged by the
   existence of folds (SC-004).

Rules 1–3 are the derivation's own unit tests; 4–5 are cross-surface
assertions.

---

## State transitions

A fold has no persisted lifecycle — it is recomputed from the loaded window.
The transitions that matter are of the *loaded window*, not of the entity:

| Trigger | Effect on the fold |
|---|---|
| A new agent event arrives live | Appended to its session; `running` stays true; counts recompute |
| `agent.session_end` arrives | `running` → false; `endTs` set; `turnCount` may become `exact` from `turns_emitted` |
| Operator pages back (`loadMore`) | `loadState` may go `edge` → `complete`; an `atLeast` count may become `exact` |
| A `session:` count query resolves | `atLeast` → `exact` |
| That query fails | `atLeast` → `unknown`; never silently → `exact` (Constitution VI) |
