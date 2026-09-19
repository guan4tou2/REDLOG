# Query Completeness Inventory

> Snapshot 2026-09-19. No production code changed — analysis only.

## Executive summary

**Every capped surface presents truncated results as if they were the complete
dataset.** No surface shows "N of M", no surface offers "load more" at the DB
level, and no surface computes a true total count. The only exception is the
Target aggregate list, which is uncapped.

**No surface has DB-level cursor/keyset pagination.** Timeline has a
`beforeCreatedAt` keyset mechanism but it is auto-triggered by scroll position,
invisible to the user, and still has no total indicator.

**Two different tier-merge strategies exist:**
- Most surfaces: `UNION ALL` with per-arm LIMIT + outer LIMIT (correct)
- HTTP History: `tier: 'logged'` only (misses chained scanner events if any
  exist — currently safe because all scanner events are in LOGGED_TIER)

---

## Per-surface inventory

### 1. Timeline

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` (UNION ALL, tier=all) |
| **WHERE** | `excludeHousekeeping` (drops session_start, api_started, hook-source) |
| **ORDER BY** | `timestamp DESC, _row DESC` |
| **LIMIT** | 200 per fetch |
| **Cursor** | Keyset on `created_at` (monotonic insertion time, not wall-clock) — auto-triggered at scroll edge |
| **Total count** | Never computed |
| **Tier handling** | UNION ALL, per-arm LIMIT + outer LIMIT |
| **Renderer post-filter** | housekeeping belt-and-suspenders, command-pair collapse, agent-turn collapse, auditor-view (drops logged tier), viewport windowing (50 events), scope/target/chain dimming |
| **Dedup** | `eventsMapRef` Map by event id |
| **Completeness visible?** | **NO** — no "N of M", no visible load-more button. `allLoaded` flag exists but is not surfaced. Event list panel capped at 50. |

**Notes:**
- Cursor column (`created_at`) differs from sort column (`timestamp`) — works
  because `created_at` is monotonically increasing per insertion.
- Only surface with any form of DB-level pagination.

### 2. Target

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` (UNION ALL) |
| **WHERE (aggregate)** | `target_id IS NOT NULL AND target_id != ''` |
| **WHERE (detail)** | `target_id = ?` |
| **ORDER BY** | Aggregate: `lastSeen DESC`. Detail: `timestamp DESC, _row DESC` |
| **LIMIT** | Aggregate: **none** (uncapped). Detail: **500** |
| **Cursor** | None |
| **Total count** | Aggregate: implicitly complete. Detail: none |
| **Tier handling** | UNION ALL on both queries |
| **Renderer post-filter** | Scope classification (in/out), scope filter chips |
| **Dedup** | `GROUP BY LOWER(target)` in aggregate SQL |
| **Completeness visible?** | Aggregate: yes (complete). Detail: **NO** — shows "+ N more" up to 500, cap is invisible. Header shows accurate `eventCount` from aggregate but detail only loads 500. |

**Key gap:** `eventCount` in header says "873" but detail loads max 500 → the
"+ 480 more" message is misleading (implies 500 total, not 873).

### 3. Loot

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` (UNION ALL, tier=all) |
| **WHERE** | `agent_type = 'loot'` |
| **ORDER BY** | `timestamp DESC, _row DESC` |
| **LIMIT** | 200 (default, not explicitly passed) |
| **Cursor** | None |
| **Total count** | None |
| **Tier handling** | UNION ALL, per-arm LIMIT + outer LIMIT |
| **Renderer post-filter** | Type filter, dedup by `(type, preview)`, infinite scroll on client array (200 per visual page) |
| **Dedup** | Client-side by `${type}|${preview}` key, toggle-able |
| **Completeness visible?** | **NO** — shows filtered count of loaded items only. DB cap of 200 events is invisible. |

**Notes:**
- Smallest cap (200) despite loot being high-value data.
- Loot has a grouping/projection problem (same credential appearing 3 times
  as 3 events vs. 1 grouped entry) — separate from pagination.

### 4. Screenshots

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` (UNION ALL, tier=all) |
| **WHERE** | `agent_type = 'screenshot'` |
| **ORDER BY** | `timestamp DESC, _row DESC` |
| **LIMIT** | 500 |
| **Cursor** | None |
| **Total count** | None |
| **Tier handling** | UNION ALL, per-arm LIMIT + outer LIMIT |
| **Renderer post-filter** | Trigger filter (periodic/manual/mark-triggered) |
| **Dedup** | None |
| **Completeness visible?** | **NO** — header shows count of loaded items (max 500), no "of M" indicator, no load-more. |

**Notes:** Code comment acknowledges the gap: "for engagements with thousands
of shots we'd want pagination but 500 covers the common case cleanly."

### 5. HTTP History

| Field | Value |
|-------|-------|
| **Source tables** | `events_logged` **only** (`tier: 'logged'`) |
| **WHERE** | `agent_type = 'scanner'` (SQL) + JS subtype filter (`http_request_start`, `http_response`) + JS `flow_id` presence |
| **ORDER BY** | SQL: `timestamp DESC, _row DESC`. Client re-sorts by selected column. |
| **LIMIT** | 5000 |
| **Cursor** | None |
| **Total count** | None |
| **Tier handling** | Logged tier only — safe because all scanner events are in LOGGED_TIER |
| **Renderer post-filter** | Heavy: subtype, text, method, status prefix, host, target, timeRange |
| **Dedup** | Flow-pair merge by `flow_id` into single `HttpFlow` object |
| **Completeness visible?** | **NO** — shows flow count from loaded data, cap invisible. |

**Notes:** Highest cap (5000) but also heaviest JS post-filter — the 5000 SQL
rows may yield far fewer visible flows after subtype + text + host filtering.

### 6. Transcript

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` (UNION ALL, tier=all) |
| **WHERE** | `agent_type = ?` per bucket (7 separate queries) |
| **ORDER BY** | SQL: `timestamp DESC, _row DESC` per bucket. JS merge: `timestamp ASC`. |
| **LIMIT** | Per-bucket: agent=800, shell=400, scanner=300, system=200, marker=100, loot=100, pivot=100. Max theoretical: 2000. |
| **Cursor** | None |
| **Total count** | None |
| **Tier handling** | UNION ALL per bucket (default tier=all) |
| **Renderer post-filter** | `buildBlocks()` subtype matching, kind filter chips, timeRange, text search |
| **Dedup** | `seen` Set by event id during merge |
| **Completeness visible?** | **NO** — shows "N blocks" post-filter, bucket saturation invisible. |

**Notes:** Balanced-bucket design prevents one type from crowding out others,
but the user cannot tell if any bucket is saturated.

### 7. Search

| Field | Value |
|-------|-------|
| **Source tables** | `events` + `events_logged` joined with `events_fts` / `events_logged_fts` |
| **WHERE** | FTS5 MATCH + optional `agent_type`, `since`, `before` (all SQL-level) |
| **ORDER BY** | `timestamp DESC, _row DESC` |
| **LIMIT** | 200 |
| **Cursor** | None |
| **Total count** | None |
| **Tier handling** | UNION ALL via FTS joins, per-arm LIMIT + outer LIMIT |
| **Renderer post-filter** | Marker amendment resolution only (all other filters pushed to SQL) |
| **Dedup** | Marker amendment fold |
| **Completeness visible?** | **NO** — "N results" where N ≤ 200, no "of M" indicator. |

**Notes:** Cleanest SQL pipeline (filters pushed to backend). Still no way for
user to distinguish "exactly 200 matches" from "5000 matches, showing 200."

---

## Cross-surface comparison

| Surface | DB cap | Cursor | Total count | Cap visible? | Tier |
|---------|--------|--------|-------------|--------------|------|
| Timeline | 200/fetch | keyset (created_at) | No | No | all |
| Target aggregate | none | No | Implicit (complete) | n/a | all |
| Target detail | 500 | No | No | No | all |
| Loot | 200 | No | No | No | all |
| Screenshots | 500 | No | No | No | all |
| HTTP History | 5000 | No | No | No | logged only |
| Transcript | 100–800/bucket | No | No | No | all |
| Search | 200 | No | No | No | all |

---

## Shared patterns observed

### What every query already does
- UNION ALL across tiers (except HTTP History: logged only)
- `ORDER BY timestamp DESC, _row DESC` as canonical ordering
- Per-arm LIMIT pushed inside UNION arms
- `rowToEvent()` as the shared row mapper

### What no query does
- Return a total count
- Expose `hasMore` to the renderer
- Use cursor pagination (except Timeline's `beforeCreatedAt`)

### Three distinct query shapes

1. **Event list** (Timeline, Target detail, Loot, Screenshots, Search):
   Simple `WHERE` + `ORDER BY timestamp DESC` + `LIMIT`. Could share a
   `queryPage()` primitive with cursor + hasMore.

2. **Aggregate** (Target aggregate, HTTP History flow-merge):
   GROUP BY / Map-merge into summary objects. Not paginated the same way.

3. **Heterogeneous merge** (Transcript):
   Multiple disjoint agent_type queries merged client-side. Per-bucket caps
   with a balanced allocation. Different enough to stay separate.

---

## Recommended minimal shared primitive

Based on this inventory, the right abstraction is NOT a generic repository.
It's a thin query-result envelope:

```typescript
interface QueryPage<T> {
  items: T[]
  hasMore: boolean
  nextCursor: string | null  // opaque, encodes (timestamp, _row, tier) keyset
}
```

### Cursor key = `(timestamp, _row, tier)`

The cursor MUST use the same columns as the canonical ORDER BY:

```sql
ORDER BY timestamp DESC, _row DESC, tier_rank DESC
```

- `_row` = SQLite `rowid`, unique per table but NOT globally unique across
  `events` + `events_logged` — two rows from different tiers can share the
  same `(timestamp, _row)`.
- `tier_rank` is the final tie-break: `chained=1, logged=0`.
- `(rowid, tier)` IS globally unique because `rowid` is unique per table.

**NOT `created_at`**: both tiers set `created_at = Date.now()` at write time,
which is not strictly monotonic (same-millisecond writes, NTP correction).

### Cursor WHERE predicate (3-level keyset)

```sql
WHERE (timestamp < :ts)
   OR (timestamp = :ts AND _row < :row)
   OR (timestamp = :ts AND _row = :row AND tier_rank < :tierRank)
```

### `_row` stays OUT of `RedLogEvent`

`_row` is SQLite pagination metadata. The cursor key is extracted from the
raw SQL result BEFORE `rowToEvent()`, passed to `encodeCursor()`, and the
opaque string travels to the renderer. The domain event model is not polluted.

### `LIMIT + 1` for `hasMore`

- Request `limit + 1` rows from DB
- If `limit + 1` rows come back → `hasMore = true`, return first `limit`
- Otherwise → `hasMore = false`, return all rows

**NOT recommended:**
- `COUNT(*)` on every query — expensive, usually unnecessary
- OFFSET-based pagination — drift risk with append-only data
- Generic repository/framework — the 3 query shapes are too different
- `created_at` as cursor key — not strictly monotonic

---

## Recommended migration order

### Batch 1: Target detail + Screenshots
- Simplest event-list queries, fewest post-filters
- Target detail has the clearest gap (aggregate says 873, detail shows 500)
- Screenshots is the simplest consumer for validating the cursor primitive

### Batch 2: Loot + Search
- Loot needs pagination badly (200 cap for high-value data)
- Search is the cleanest SQL pipeline, easy to add cursor
- Loot's grouping/projection problem is **separate** — don't block pagination on it

### Batch 3: Timeline
- Already has keyset pagination — migrate to shared primitive
- Largest renderer post-filter surface, highest risk

### Batch 4 (or never): Transcript + HTTP History
- Transcript's heterogeneous merge may never fit a generic cursor
- HTTP History's flow-pair merge needs per-flow pagination, not per-event

---

## Domain invariant (to add to glossary)

> **Capped View Completeness**: Any bounded query result MUST NOT let the UI
> present partial results as if they were the complete dataset. The renderer
> must know `hasMore` and either (a) show a "load more" affordance, or
> (b) show "N of M" when a total is available, or (c) show "N+" when only
> hasMore is known.
