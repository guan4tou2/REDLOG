# Data Model: Timeline on the Shared Filter

No stored data changes. Every entity below is either query input or renderer
state. Chained and logged rows, their hashes and `target_id` are read as
recorded (Constitution I).

## SharedFilter (renderer, `lib/FilterContext.tsx`)

The FilterBar's state, one per open project. It is not persisted, and it starts
empty each time `FilterProvider` mounts.

| Field | Type | Default | Change |
|-------|------|---------|--------|
| `targetId` | `string \| null` | `null` | Now also set by the Targets page (R4) |
| `agentType` | `string \| null` | `null` | — |
| `timeRange` | `{ since?, before? } \| null` | `null` | — |
| `inScopeOnly` | `boolean` | `false` | — |
| `hidePersonal` | `boolean` | `true` | — |
| `tier` | `'all' \| 'chained'` | `'all'` | **New** (R2) |

- `activeCount` counts `tier === 'chained'` as one active condition. As today,
  `hidePersonal` (on by default) is not counted.
- `toEventFilter` maps `tier: 'chained'` to `{ tier: 'chained' }`, and `'all'`
  to nothing.

## EventFilter (wire and core, `core/db/event-queries.ts`)

What the renderer sends, and what main widens with the active scope policy
(`withActiveScope`). A renderer value can narrow the result, never widen it.

| Field | Type | Evaluated as |
|-------|------|--------------|
| `targetId` | `string` | `target_id = ? COLLATE NOCASE` (R3, **changed**) |
| `agentType` | `string` | `agent_type = ?` |
| `since` / `before` | `number` | `since ≤ timestamp ≤ before` |
| `inScopeOnly` + `scope` | `boolean`, policy | the canonical evaluator (untargeted rows kept) |
| `hidePersonal` + `personalDomains` | `boolean`, list | the canonical evaluator (untargeted rows kept) |
| `tier` | `'chained'` | logged arm excluded (R2, **new**) |

`appendEventFilter(filter, parts, params, arm, alias?)` takes a **required**
`arm: 'chained' | 'logged'`.

## Query request options (core)

| Option | On | Meaning |
|--------|----|---------|
| `excludeHousekeeping` | `queryEventsPage`, `EventQueryRequest`, `countEvents`, `matchEventIds` | adds `HOUSEKEEPING_SQL`; **new** on all four |
| `cursor` | every page query and `countEvents` | the canonical keyset `(timestamp, rowid, tier)`; `countEvents` counts strictly past it |
| `ids` | `matchEventIds` | restrict evaluation to these event ids (at most 1,000 a call) |

## ParsedQuery conditions (`core/query/contract.ts`)

| Field | Stored value | Change |
|-------|--------------|--------|
| `event` | `id` | — |
| `session` | `data.session_id` | — |
| `transcript` | `transcript_uuid` / `data.transcript_uuid` | — |
| `tool` | `data.tool_use_id` | — |
| `operator` | `operator_id` | **New** (R7) |

## TimelineRange (renderer, Timeline)

The one contiguous range the Timeline draws: every admitted event, from newest
down to the oldest loaded.

| Field | Meaning |
|-------|---------|
| `items` | the admitted rows loaded, in canonical order |
| `cursor` | `nextCursor` of the last page; `null` when `hasMore` is false |
| `hasMore` | older admitted rows exist |
| `total` | `countEvents({ filter, excludeHousekeeping })` |
| `generation` | incremented on every filter change; a response from an older generation is dropped |

State transitions:

```
shared filter changes → generation++ → items = [], cursor = null → load page 1 → total
scroll to the old edge → load the next page (cursor)
loadBackTo(id)       → matchIds([id]) → admitted?  no → "outside the filter" notice
                                      → yes → load pages of 1,000 until id is drawn
live batch           → nothing set ? admit : matchIds(new ids) → insert the admitted ones
```

## TimelineText (renderer, Timeline)

| State | Entered when | Drawn |
|-------|--------------|-------|
| `empty` | text is blank | all admitted events, none dimmed |
| `unparsable` | `parseQuery` fails | nothing dimmed; the read-out shows the reason |
| `matching` | parsed, and the requests are in flight | the previous matches, marked as updating |
| `matched` | `matchIds` resolved | non-matching events dimmed; `earlier` count and nearest id known |
| `failed` | any of the three requests throws | nothing dimmed; failure with retry |

A match on a folded row is shown on the row it folds into (research R5).

## DisplayZone (renderer, `lib/time`)

| Value | Printed |
|-------|---------|
| `'local'` (default) | `15:04`, `2026-09-24 15:04` |
| `'utc'` | `07:04Z`, `2026-09-24 07:04Z` |

Stored as `redlog-display-zone` in `localStorage`, per machine. Its first read
migrates `redlog-timeline-tz`: `'utc'` becomes `'utc'`, anything else `'local'`.
Exports are unaffected (ISO 8601 with offset).
