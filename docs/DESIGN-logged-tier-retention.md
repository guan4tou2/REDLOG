# Logged-tier retention

**Status:** proposed, targeting v0.13.0 (co-lands with the two-tier chain)
**Author:** logged-tier retention design pass
**Parent doc:** [DESIGN-two-tier-chain.md](DESIGN-two-tier-chain.md) — the two-tier chain is a prerequisite; this doc closes the gap §13.3 of that doc explicitly deferred.
**Prior art:** [`src/core/retention.ts`](../src/core/retention.ts), [audit-trail.md](audit-trail.md), [event-schema.md](event-schema.md), [ROADMAP.md](ROADMAP.md).

The two-tier chain landed in v0.12.2 as decision-point material and defined a `events_logged` table with no `no_delete` trigger — *deliberately*. §13.3 of [DESIGN-two-tier-chain.md](DESIGN-two-tier-chain.md) states the intent plainly:

> Not addressed in v0.13. The logged tier will grow unboundedly by default; a follow-up ticket (`RETENTION-logged-tier`) needs to […] emit `system.retention_pruned_logged` chained events summarising the sweep […]. Default retention: "keep last 30 days of logged tier". Configurable per-project.

This document is that follow-up. It answers the questions §13.3 punted on: **when does a logged-tier row expire, who decides, how does the sweep prove it happened, and how does an evidence bundle survive the truncation?**

The naming worth pinning up front: "retention" in RedLog has historically meant *file-level* retention — the `.cast` and screenshot on-disk files that get pruned by [`sweepRetention()`](../src/core/retention.ts) while their event rows stay in the chain. This doc introduces the first *row-level* retention policy in the system. The distinction matters because a pruned file leaves a chained `system.screenshot_pruned` breadcrumb pointing at where the deleted file used to live; a pruned logged row leaves *only* the aggregate `system.retention_pruned_logged` event described in §6. There is no per-row breadcrumb — that would defeat the pruning.

---

## 1. Motivation

### 1.1 The §13.3 gap in numbers

The parent doc used a headline number to justify the split: "an engagement doing 200 DNS queries/second for a week generates ~120M rows". Retention is what saves that engagement's operator from a 40 GB `.redlog/projects/<name>/events.db`.

A concrete scenario — the one that motivated this design:

> An external red-team engagement running mitmproxy through a live target list. DNS resolver logging is on (200 evt/s spike, ~50 evt/s sustained). The HTTP flow addon is on (100 evt/s during active probing, ~20 evt/s ambient). CDP browser console messages contribute ~5 evt/s. Total logged-tier: ~275 evt/s sustained across working hours, spiking to ~800 evt/s during a mass scan.
>
> After **one calendar week** of nine-hour engagement days: **~40M logged rows**. Median logged-row payload size (`agent_type` + `subtype` + JSON `data`) is ~250 bytes on-disk; total logged storage weight is ~10 GB, with SQLite indexes adding another ~4 GB. WAL turnover during scans adds burst pressure but is bounded.
>
> After **one calendar month** of the same engagement: **~180M logged rows, ~60 GB events.db, ~15 GB of secondary index storage**.

SQLite handles this — the parent doc's §5.1 performance note is not wrong — but the operator's home directory does not. `~/.redlog/projects/<name>/events.db` is the artifact an operator carries between machines; a 60 GB SQLite file is disqualifying for that workflow whether or not SQLite can query it.

### 1.2 The parent doc's own hedge

§13.5 of the parent doc says the sampler *doesn't* watch the logged tier because "the logged tier is designed to be prunable, so DELETE is a first-class operation there." That sentence made a *design commitment* — the schema in §3.2 was written without the append-only trigger *precisely* to make retention possible. Retention has been an architectural TODO since the day the two-tier design was drafted.

The gap is that "prunable" without a policy just means "prunable by hand". No operator ever prunes by hand. The table grows unboundedly by default; every existing engagement grows a bigger table every day. Without a default, the schema commitment cashes out as "someone eventually has to write a DELETE statement", which is exactly the class of maintenance task that doesn't happen.

### 1.3 Why the policy must be conservative

A pruned logged row is unrecoverable. The append-only-file model that protects chained rows (§4.2 of the parent doc's discussion of `assertEventsAppendOnly`) explicitly does *not* apply here — the sweep uses `DELETE FROM events_logged`, which SQLite happily executes and which is not journaled anywhere the operator can walk back. If the operator ran a scan two months ago and now needs to prove which DNS names it touched, the answer under a too-aggressive retention policy is *the row is gone*.

That constraint shapes every default in this doc:

- **30-day default** (§4), not seven, not fourteen. A red-team engagement usually runs one to four weeks; the operator's retrospective analysis is done in the first two weeks after ship. Thirty days is the smallest window that survives every real workflow we've seen.
- **Age is primary, size is a ceiling** (§3). A size cap can silently delete an in-flight engagement's evidence if the operator forgot to check disk; an age cap can only delete rows the operator already saw come and go.
- **Every prune fires a chained summary** (§6). Even after the rows are gone, the audit chain records that they existed, when the newest one was, and when it happened. This is the concession that makes the deletion defensible.

---

## 2. Design goals

Four properties every part of this design has to satisfy:

### 2.1 Total

Every row that ever lands in `events_logged` must have a lifecycle. There is no "and eventually we'll add retention" mode after v0.13. The policy runs on install, on every project open, and on a periodic timer. A row inserted today has a known expiry date the day it's inserted.

### 2.2 Predictable

An operator with a running engagement must be able to answer, without opening the code:

> How long until my DNS log for target X starts falling off?

The answer is a single number configured in one place. There are no hidden interactions with other producers, no "if the log gets big we prune earlier" quiet mode, no LRU-style behaviour that depends on read patterns. Age in, age out.

### 2.3 Auditable

The sweep itself must be a chained event. Not "we logged that we swept" as a side effect; the sweep *is* an audit-tier action, in the same conceptual bucket as `system.screenshot_deleted` and `system.cast_pruned` — evidence that evidence was removed by policy. See §6 for the exact event shape.

### 2.4 Safe

Defaults must be generous. A mid-engagement code review by a client-side observer must not find themselves looking at a database whose logged tier has already been pruned to the point that the DNS lookups behind last Tuesday's shell command are gone. The 30-day default (§4) is the operative expression of this — but the design also protects against foot-guns: the sweep obeys `eventBus.paused` (§5.4), it batches its DELETE (§5.3) so a WAL storm doesn't stall the app, and it emits a chained warning on first-run if the operator's data would immediately exceed the policy (§10).

---

## 3. What "retention" means for the logged tier

Three axes are candidates for the primary retention knob:

### 3.1 Axis A — age

`DELETE FROM events_logged WHERE created_at < now - keepDays * 86400_000`.

Simplest to reason about; matches the mental model of `castKeepDays` and `screenshots.keepDays` operators already understand. Independent of load — a quiet week and a busy week trip the same boundary. Predictable in the strong sense of §2.2. This is the recommended primary knob.

### 3.2 Axis B — size

`DELETE FROM events_logged WHERE rowid IN (SELECT rowid FROM events_logged ORDER BY created_at ASC LIMIT N) UNTIL SUM(page_count) < maxSizeBytes`.

Attractive because it directly bounds the artifact size operators worry about. Rejected as *primary* because it makes retention observable-load-dependent: an operator running one heavy mitmproxy day loses evidence from the *previous* week's engagement to make room. That inverts the safety property in §2.4.

Kept as a *ceiling* (§7.1): if the operator sets `maxSizeGb: 5`, the sweep enforces it *in addition to* age, in the sweep pass, with an explicit warning event fired before the size-driven pass runs so the operator sees "size cap kicked in — you may want a bigger cap or more disk".

### 3.3 Axis C — count

`DELETE FROM events_logged ORDER BY created_at ASC LIMIT (COUNT(*) - maxRowCount)`.

Similar shape to Axis B but on a metric operators think about less naturally. Kept as a ceiling for the same reason (a plugin author who wants to cap their own logged-tier producer at N rows can use `maxRowCount` even if they don't know the byte size). Not recommended for daily use.

### 3.4 The recommendation

> **Age is primary. Size and count are optional ceilings.**

The config surface (§7) exposes all three, but only `keepDays` has a non-conservative default. `maxSizeGb` and `maxRowCount` are `undefined` by default — an operator explicitly opts in to those. This mirrors the existing convention in [`src/core/config.ts`](../src/core/config.ts) where `keepDays: 0` means "keep forever": the primary knob defaults to a reasonable positive value (30 days here), while the optional ceilings default to off.

---

## 4. Recommended defaults

The default retention policy for v0.13.0:

```ts
// Recommended in src/core/config.ts
retention: {
  loggedTier: {
    keepDays: 30,                 // primary — see §3.4
    maxSizeGb: undefined,         // ceiling; off by default
    maxRowCount: undefined,       // ceiling; off by default
    sweepIntervalHours: 24        // §5.2
  }
}
```

### 4.1 Why 30 days

The 30-day boundary comes from three observations:

1. **Engagement duration.** External red-team engagements at the shops RedLog targets are typically 1–4 weeks of active work. Blue-team simulations and internal assessments are typically 2–3 weeks. Thirty days keeps the *entire* engagement's supporting evidence live for the retrospective review.

2. **Retrospective analysis lag.** The retrospective usually happens 1–2 weeks after the last operator day. The last "why did this shell command hit that DNS name" investigation lands around day 20–25 of the engagement. Thirty days covers this window with a full week of buffer.

3. **Client / customer review lag.** For engagements delivered to an external client, the client's post-report follow-up questions ("what did you actually do to X?") typically land within 30 days of report delivery. After that, the primary evidence — the chained tier and the exported bundle — carries the story; the logged tier is investigative only.

Rejected alternatives:

- **7 days:** cuts off the retrospective review window. Fine for a continuous production monitor; wrong for engagement-shaped work.
- **14 days:** covers active work but not retrospective. Loses the "last Tuesday's DNS lookups" case in §2.4 for a two-week engagement.
- **60 days:** doesn't materially change the audit story past 30 days (the bundle already tells it) and lets the DB grow to ~30 GB in the §1.1 scenario, which is the number this doc exists to prevent.
- **Keep forever (0d, matching cast/screenshot convention):** would replicate the pre-v0.13 shape where the parent doc explicitly noted "grows unboundedly by default". This is the shape we are moving *away* from.

### 4.2 Compare against existing retention defaults

The retention defaults RedLog already ships (verified against `DEFAULT_CONFIG` in [`src/core/config.ts`](../src/core/config.ts) as of v0.12.2):

| What | Default | Why |
|---|---|---|
| `terminal.castKeepDays` | `0` (keep forever) | The `.cast` file is the raw terminal recording — losing it is losing primary evidence. Operators opt in. |
| `screenshots.keepDays` | `0` (keep forever) | Same story: a screenshot IS primary evidence. |
| `agentTailer` (agent transcripts) | v0.7.4 F2: `0` (keep forever) | The [`agent-transcript-tailer.ts`](../src/main/services/agent-transcript-tailer.ts) originally shipped with a 30-day sweep default and was changed to 0 in v0.7.4 F2 after a corruption path was found: pruning a sidecar whose upstream Claude Code `.jsonl` still existed caused every historical turn to be re-inserted as fresh chained events on next project open. The fix was two-fold — a DB-side dedup seed + reverting the default to "keep forever" to match sibling conventions. |

Every existing retention default is **0 = keep forever** because everything the existing sweeper touches is *primary evidence*. The logged tier is the first RedLog artifact that isn't primary evidence by design — that's what the two-tier chain change was *for*. So the 30-day default is not a policy inconsistency; it's the first default that reflects the new tier being non-primary.

### 4.3 Env var override

For CI / air-gapped installs that manage config through env, a single override:

```
REDLOG_LOGGED_RETENTION_DAYS=90
```

Read by `loadConfig` after the YAML merge (§7.2). Only `keepDays` is overridable this way; size and count ceilings are considered advanced knobs that belong in the YAML.

---

## 5. The sweep

### 5.1 Where it runs

The sweep runs in **two places**:

1. **On project open**, right after [`sweepRetention()`](../src/core/retention.ts) fires the file-level sweep in [`src/main/index.ts` §475](../src/main/index.ts). The logged-tier sweep is added as a sibling call:

   ```ts
   // src/main/index.ts — right after existing sweepRetention()
   try {
     const swept = sweepRetention(config, { engagementId, operatorId })
     if (swept.cast > 0 || swept.screenshots > 0) {
       console.log(`[retention] pruned ${swept.cast} .cast file(s) + ${swept.screenshots} screenshot(s)`)
     }
     const loggedSwept = sweepLoggedTier(config.retention?.loggedTier, { engagementId, operatorId })
     if (loggedSwept.deleted > 0) {
       console.log(`[retention] pruned ${loggedSwept.deleted} logged-tier row(s), ` +
         `freed ~${(loggedSwept.bytesFreed / 1024 / 1024).toFixed(1)} MB`)
     }
   } catch (e) { console.error('[retention] sweep failed:', e) }
   ```

2. **Periodically**, on a `setInterval` timer whose cadence is `sweepIntervalHours` (default 24). This is *new behaviour* compared to the file-level sweep — cast/screenshot retention runs only on project open today, precisely because the operator is expected to close and reopen the app during a long engagement. The logged tier can grow 20–40 GB *during* a nine-hour engagement day; waiting for the next project open would defeat the safety property in §2.4.

The periodic timer runs in the main process, holds a weak reference to the config object, and re-reads the pause state on each tick (§5.4).

### 5.2 The SQL

The base statement:

```sql
DELETE FROM events_logged WHERE created_at < ?
```

`created_at` is preferred over `timestamp` because `created_at` is monotonic in wall-clock terms (see [`src/core/db/events.ts` §80–95](../src/core/db/events.ts)) — a row's `timestamp` field can lag or lead by a small amount depending on producer clocks, but `created_at` is set at row-insertion time from `Date.now()` inside the insert transaction. Retention on `created_at` therefore guarantees "any row that was inserted more than N days ago" regardless of upstream clock drift.

The table already has `idx_events_logged_created_at` from the parent doc's §3.2 index list, so the plan is an index range scan.

### 5.3 Transactional shape — batched deletes

A 40 GB DELETE in one transaction would:

- Hold a write lock on the DB for however long SQLite takes to rewrite the WAL.
- Balloon the WAL file to hundreds of MB before checkpoint.
- Stall every other DB write behind it, including chained-tier inserts from live producers.

So the sweep batches. Pattern:

```ts
function sweepLoggedTier(cfg: LoggedTierRetentionConfig, ctx: SweepCtx): LoggedSweepResult {
  const db = getDB()
  const keepDays = cfg.keepDays ?? 30
  if (keepDays <= 0) return { deleted: 0, bytesFreed: 0, ...}    // 0 = keep forever, honoured
  const cutoff = Date.now() - keepDays * DAY_MS

  // Preflight: capture the window so the summary event (§6) can report
  // oldest/newest deleted timestamps and count without a second scan
  // after the fact.
  const preflight = db.prepare(`
    SELECT MIN(created_at) AS oldest,
           MAX(created_at) AS newest,
           COUNT(*)        AS total,
           SUM(LENGTH(data)) AS approx_bytes
      FROM events_logged
     WHERE created_at < ?
  `).get(cutoff) as { oldest: number | null; newest: number | null; total: number; approx_bytes: number | null }

  if (preflight.total === 0) return { deleted: 0, bytesFreed: 0, ... }

  const BATCH = 10_000
  const startedAt = Date.now()
  let deleted = 0
  while (true) {
    if (eventBus.paused) break                                        // §5.4
    const info = db.prepare(`
      DELETE FROM events_logged
       WHERE rowid IN (
         SELECT rowid FROM events_logged
          WHERE created_at < ?
          ORDER BY created_at ASC
          LIMIT ?
       )
    `).run(cutoff, BATCH)
    deleted += info.changes
    if (info.changes < BATCH) break
  }

  // WAL checkpoint after a large-batch delete so the file size actually drops.
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)') } catch { /* best-effort */ }

  return {
    deleted,
    bytesFreed: preflight.approx_bytes ?? 0,
    oldestDeletedAt: preflight.oldest ?? 0,
    newestDeletedAt: preflight.newest ?? 0,
    durationMs: Date.now() - startedAt
  }
}
```

Notes:
- Batches of 10,000 rows deliberately match a middle-ground write-lock hold time; on the §1.1 scenario a 4M-row sweep is 400 batches, each holding the write lock for a few hundred ms. Producers writing at 200/s see occasional lock waits but no data loss.
- `PRAGMA wal_checkpoint(PASSIVE)` after batching so the WAL doesn't balloon indefinitely. `PASSIVE` is chosen over `FULL`/`RESTART`/`TRUNCATE` because it doesn't wait for readers to drain — reader-blocking during a nine-hour engagement would violate §2.2.
- Ceilings (`maxSizeGb`, `maxRowCount`) are enforced as a *second pass* after the age pass, with the same batched shape. See §7.1.

### 5.4 Pause interaction

The sweep respects `eventBus.paused` (verified against [`src/core/event-bus.ts` §12](../src/core/event-bus.ts) — the boolean lives on the bus and is toggled by `pause()`/`resume()`). If the operator has paused recording (⌘. or the tray-menu button), the sweep does not run. Reasoning:

- Pause means "the operator does not want the DB touched right now" — a scope broader than just "don't accept new events". A sweep during a paused window would silently delete rows an operator wouldn't expect to be losing.
- The parent doc's §4.2 dispatch already respects `eventBus.paused` at insert time; retention respecting it at sweep time is the symmetric closure.
- The periodic timer keeps ticking during pause; it just no-ops. When the operator resumes, the next tick runs the sweep normally.

Test coverage for this is explicit (§12).

### 5.5 What the sweep does *not* touch

- **The `events` table** — chained tier is append-only and must remain so. The sweep issues DELETEs *only* against `events_logged`. A defensive test asserts this at the SQL-string level (§12).
- **The chained anchor state** — `computeChainHead`, `cachedLastHash`, `cachedEventCount` all read from `events` and are unaffected.
- **The `_causes` targets on chained rows** — if a chained row cites a soon-to-be-pruned logged row via `_causes`, the citation stays; §9 discusses the dangling-pointer semantics.
- **Sanitization state** — `sanitized_events` rows for logged-tier sources (parent doc §7.4) are keyed by `source_event_id`; when the source row is pruned, the sanitized entry stays as an orphan. That's cheap (kilobytes) and captures "this row *was* redacted at export time" as a historical fact. A future v0.14 cleanup can garbage-collect them if needed.

---

## 6. The summary event

The whole point of §2.3's auditability constraint is that a chained event says "this happened".

### 6.1 Shape

Type: **`system.retention_pruned_logged`** — a chained event, i.e. lands in the primary `events` table via the two-tier classifier's default path (parent doc §4.1). It is not in `LOGGED_TIER`.

```ts
{
  agentType: 'system',
  data: {
    subtype: 'retention_pruned_logged',
    count: 4_218_733,                  // rows deleted this sweep
    oldest_deleted_at: 1737936000000,  // ms epoch — earliest created_at pruned
    newest_deleted_at: 1740528000000,  // ms epoch — latest created_at pruned
    bytes_freed_approx: 1_074_083_328, // SUM(LENGTH(data)) of pruned rows
    duration_ms: 41_233,               // wall-clock time of the sweep
    engagement_id: 'engagement-uuid',
    trigger: 'periodic' | 'project_open' | 'operator_forced',
    keep_days: 30,
    size_cap_hit: false,               // §7.1 — was maxSizeGb the reason?
    count_cap_hit: false,              // §7.1 — was maxRowCount the reason?
    description: 'retention: pruned 4,218,733 logged-tier rows older than 30d (~1.02 GB freed)'
  }
}
```

Fires **only when `count > 0`** — an empty sweep on an empty table (or a table with nothing past the cutoff) does not chain an event. That matches the existing convention of [`sweepDir`](../src/core/retention.ts) not firing `cast_pruned` when nothing is pruned. A steady state of `retention_pruned_logged` events every 24h would drown the chained tier in metadata; sweeping and finding nothing is a healthy no-op.

### 6.2 The emit snippet

Where §5.3's `sweepLoggedTier` returns:

```ts
if (result.deleted > 0) {
  try {
    const ev = insertEvent('system', {
      subtype: 'retention_pruned_logged',
      count: result.deleted,
      oldest_deleted_at: result.oldestDeletedAt,
      newest_deleted_at: result.newestDeletedAt,
      bytes_freed_approx: result.bytesFreed,
      duration_ms: result.durationMs,
      engagement_id: ctx.engagementId,
      trigger,                     // supplied by caller — 'periodic', etc.
      keep_days: cfg.keepDays ?? 30,
      size_cap_hit: result.sizeCapHit ?? false,
      count_cap_hit: result.countCapHit ?? false,
      description: `retention: pruned ${result.deleted.toLocaleString()} logged-tier rows ` +
        `older than ${cfg.keepDays ?? 30}d (~${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB freed)`
    }, ctx)
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('retention-sweep-logged', e) }
}
```

Rides the **same hash chain as everything else**. The two-tier classifier sees `agent_type='system'` + `subtype='retention_pruned_logged'`, doesn't find it in `LOGGED_TIER`, and lands it chained. The event's hash covers its own `data` block including the counts and timestamps, so a later attempt to rewrite the summary to hide a sweep would break the chain in the same way a rewrite of any other chained row would.

### 6.3 Cross-reference to `cast_pruned` and `screenshot_pruned`

The design pattern mirrors the existing pruning breadcrumbs:

| Event | Aggregation | Scope |
|---|---|---|
| `system.cast_pruned` | one per file | file-level; carries the path + basename |
| `system.screenshot_pruned` | one per file | file-level; carries the path + basename |
| `system.retention_pruned_logged` | **one per sweep** (not per row) | row-level; carries aggregate stats |

Per-row breadcrumbs on the logged tier were considered and rejected: pruning 4M rows would chain 4M new events, defeating the tier split entirely. Aggregate-only is the right unit.

The chained-row-count number (§9.4 of the parent doc, the StatusBar's `chained · logged` split) shows one summary event, not four million.

---

## 7. Config surface

### 7.1 The shape

Additive to `RedLogConfig` in [`src/core/config.ts`](../src/core/config.ts):

```ts
export interface RedLogConfig {
  ...existing...
  /** v0.13: logged-tier retention. The chained tier is append-only by
   *  contract and cannot be pruned. The logged tier (DNS lookups, HTTP
   *  flow bookkeeping, agent thinking, CDP console, alert heartbeats)
   *  is designed to be prunable — see DESIGN-logged-tier-retention.md.
   *
   *  Defaults: keep last 30 days. No size cap. No row-count cap.
   *  Sweep runs on project open and every 24h.
   *
   *  Env var override: REDLOG_LOGGED_RETENTION_DAYS overrides keepDays. */
  retention?: {
    loggedTier?: {
      /** Age cutoff in days. `0` = keep forever (matches castKeepDays
       *  and screenshots.keepDays convention — see §4.2). Default 30. */
      keepDays?: number
      /** OPTIONAL ceiling: when the events.db grows beyond this many GB,
       *  the sweep additionally prunes oldest-first until under the cap.
       *  Undefined = no cap. Chained tier is NOT counted against this. */
      maxSizeGb?: number
      /** OPTIONAL ceiling: when events_logged row count exceeds this,
       *  the sweep additionally prunes oldest-first until under the cap.
       *  Undefined = no cap. */
      maxRowCount?: number
      /** How often the periodic sweep runs. Ignored on project-open sweep.
       *  Default 24. Minimum 1 (values <1 clamp to 1 to keep the sweep
       *  from thrashing the WAL). */
      sweepIntervalHours?: number
    }
  }
}
```

`DEFAULT_CONFIG` gets a corresponding block:

```ts
retention: {
  loggedTier: {
    keepDays: 30
    // maxSizeGb, maxRowCount deliberately absent — undefined
    sweepIntervalHours: 24
  }
}
```

### 7.2 Env var override

At the end of `loadConfig`:

```ts
const envKeepDays = process.env.REDLOG_LOGGED_RETENTION_DAYS
if (envKeepDays) {
  const n = Number(envKeepDays)
  if (Number.isFinite(n) && n >= 0) {
    merged.retention = merged.retention ?? { loggedTier: {} }
    merged.retention.loggedTier = merged.retention.loggedTier ?? {}
    merged.retention.loggedTier.keepDays = n
  }
}
```

Rejected values (negative, NaN, missing) fall through to the YAML/default — no silent 0 that would toggle "keep forever" mode based on a typo'd env.

### 7.3 The ceiling pass

When `maxSizeGb` or `maxRowCount` are set, the sweep runs a second pass after the age pass, deleting oldest-first until under the cap. The summary event's `size_cap_hit` / `count_cap_hit` fields distinguish which ceiling fired.

Order matters: age first, then size, then count. Reasoning:

- Age is the primary knob (§3.4). It cuts against a criterion the operator explicitly asked for.
- Size/count are safety nets — the operator setting them is saying "cap this even if the age pass wasn't enough". Running them after age gives age priority over "I'm out of disk".
- A row that just barely survives the age pass but gets deleted by the size pass is unusual and worth surfacing — the summary event's cap flags make it observable.

### 7.4 What the config surface *doesn't* have

- **No per-`agent_type` retention** — every logged-tier row lives under the same policy. A future v0.14 could add `retention.loggedTier.byAgent = { dns: 60, scanner: 14 }` but that's overkill for v0.13.
- **No "keep last N rows per session"** — session-scoped retention would need to walk foreign-key-shaped joins the schema doesn't cheaply support.
- **No exclusion list** — no `retention.loggedTier.exclude = ['scanner:http_error']`. If a producer's rows should be kept longer than the default, that producer belongs in the chained tier, not the logged tier with a per-subtype opt-out.

---

## 8. Interaction with bundle export

### 8.1 The base question

Cross-referencing [`src/core/bundle-export.ts`](../src/core/bundle-export.ts) (verified as of v0.12.2): the current bundle writer iterates the whole `events` table into `events.jsonl` in insertion order. The parent doc §7.1 adds an `events_logged.jsonl` sibling that iterates `events_logged` the same way.

The question is: **do pruned rows appear in a bundle exported after the sweep?**

Answer: **no**. `events_logged.jsonl` is populated from `SELECT * FROM events_logged` at export time. Once the sweep has committed, the rows are gone and don't appear in any subsequent bundle. This is the point of retention — a bundle exported 45 days into an engagement will legitimately not carry the day-1 DNS lookups, because those are past the 30-day window.

### 8.2 The observable consequence

A bundle exported *before* a sweep has more logged rows than one exported *after*. Two bundles of the same engagement — one on day 29, one on day 31 — will differ in `events_logged.jsonl` even though nothing "happened" between them from the operator's point of view.

This has to be made *legible* in the manifest, or an auditor comparing two bundles from the same engagement will read the diff as tampering.

### 8.3 The `pruneWatermark` manifest field

Add to `ManifestPayload` (which the parent doc §7.2 already extended with `tiers`):

```ts
interface ManifestPayload {
  bundleVersion: 2
  ...
  tiers: { chained: number; logged: number }
  /** v0.13 retention: the oldest `created_at` still present in
   *  events_logged.jsonl at export time. Anything older than this
   *  timestamp was pruned by policy and is intentionally absent from
   *  this bundle. Presence of an older `_causes` reference from
   *  events.jsonl into a row older than pruneWatermark is expected —
   *  that's a dangling pointer by design (see §9).
   *
   *  If events_logged is empty, pruneWatermark is null. */
  pruneWatermark: number | null
  /** v0.13 retention: policy at export time. Explaining "why does the
   *  window start here?" without the reader having to open config.yaml. */
  retentionPolicy: {
    keepDays: number
    maxSizeGb: number | null
    maxRowCount: number | null
  }
  ...
}
```

Populated during bundle export as:

```sql
SELECT MIN(created_at) FROM events_logged
```

Both fields are additive to the v0.13 `bundleVersion: 2` schema and don't require another version bump — they document behaviour that was already permitted (retention pruning) but weren't visible in the manifest.

### 8.4 The bundle README

The README written by `bundle-export.ts` gets one more paragraph in its "What's in this bundle" section (parent doc §7.3):

```
- **Retention window** — this bundle's events_logged.jsonl starts at
  <pruneWatermark ISO-8601>. Anything older than that was pruned by
  the engagement's retention policy (currently: keep last N days).
  You'll see chained events (in events.jsonl) whose `_causes` field
  references logged-tier rows that predate the watermark — those
  references are dangling by design; the chained row's own hash is
  unaffected by the missing target.
```

An auditor reading two bundles from the same engagement now has a straight explanation for why day-29 has more `events_logged` rows than day-31: **look at the watermark**.

### 8.5 Bundle export during a sweep

The one race worth naming: what if `bundle-export.ts` starts an export mid-sweep? Both are hitting the same SQLite file.

SQLite's default WAL isolation gives the exporter a snapshot read: the export sees the state of `events_logged` at the moment its first SELECT started, and any deletes that commit after that point don't affect the export in progress. The bundle either:

- Started before the sweep committed → exports the pre-sweep state, `pruneWatermark` shows the pre-sweep min. The sweep commits after export finishes; next bundle will show the post-sweep state.
- Started after the sweep committed → exports the post-sweep state directly.

In neither case does the bundle capture a partial mid-sweep state. WAL isolation carries this for free; no code change needed in the exporter. See §13 for the explicit test.

---

## 9. Interaction with the chain

### 9.1 The chained summary event is normal

Nothing exotic — `system.retention_pruned_logged` chains through `insertChainedEvent` the same as `system.recording_paused` or `system.ip_transition`. Its hash covers the `data` block including the aggregate counts, so a rewrite of "we pruned 4M rows" to "we pruned 0 rows" invalidates the chain in the ordinary way.

### 9.2 Dangling `_causes` pointers

This is the pointed case, and it's exactly the shape [DESIGN-two-tier-chain.md §6.2](DESIGN-two-tier-chain.md) already worked through:

> `_causes` is a soft causal pointer. […] If someone later prunes the logged row, the id string in `_causes` becomes a dangling pointer — that's a UI concern, not a chain-integrity concern.

Concretely: `system.scope_violation` (chained) whose `_causes: [dnsId]` cites a `dns.dns_query` (logged) row. Thirty-one days later the DNS row is pruned. The scope_violation row still exists. Its hash still covers the `_causes` array as a set of id strings; the hash doesn't reach through and hash the target row. So:

- **Chain integrity: unaffected.** `verifyChainFull` passes. `verifyRandomSample` passes. The Ed25519 signature verifies. The OTS anchor covering the chain head still verifies.
- **UI: shows "referenced row pruned".** [`Timeline.tsx`](../src/renderer/src/components/Timeline.tsx) and the causes-resolver look up `_causes` targets via `queryEventById` (parent doc §5.3, which checks both tables); a miss in both tables becomes the "referenced row pruned by retention policy" chip. See §11.

The parent doc's §6.2 statement — "the claim the row is making is 'here are strings I stored', not 'here are rows I can promise exist'" — is the load-bearing sentence for this whole design. Retention makes that claim's second half potentially false; the design accepts the tradeoff.

### 9.3 What "pruned" is distinct from "never existed"

A chained row's `_causes` pointing at an id that was never written is a different failure mode from one whose target was written and then pruned. The UI distinguishes:

- **Missing (pruned):** target id < `pruneWatermark` at query time → "pruned by retention policy on <sweep date>". Sweep date is looked up by finding the `system.retention_pruned_logged` event whose window covers the target's `created_at`.
- **Missing (never existed):** target id ≥ `pruneWatermark` → "referenced row not found (possibly a bug — file an issue)".

Both cases are recoverable from the operator's point of view: the parent chained row still holds every field of its own claim; the citation is context, not content.

### 9.4 The chained-only walker still walks cleanly

[`chain-anchor.ts`](../src/core/chain-anchor.ts) walks the `events` table only, so nothing about the sweep affects the walk. The head hash count comes from `getEventCount({ tier: 'chained' })` per parent doc §5.4; the sweep never changes that count.

The one bookkeeping item: `system.retention_pruned_logged` events *do* count toward chained rows. They're supposed to — an auditor looking at the anchor's `eventCount` sees a slightly higher number than they would in a v0.12.x bundle, and part of the difference is these summary events. Bundle README calls this out.

---

## 10. UI

### 10.1 Settings ▸ Retention gains a "Logged tier" section

[`Settings.tsx`](../src/renderer/src/components/Settings.tsx) already has a Retention area for `castKeepDays` and `screenshots.keepDays`. The logged-tier section sits below them:

```
Retention

  .cast files                Keep for [  0  ] days   (0 = keep forever)
  Screenshots                Keep for [  0  ] days   (0 = keep forever)
  Agent transcripts          Keep for [  0  ] days   (0 = keep forever)

  Logged tier (v0.13)
    DNS, HTTP, console,      Keep for [ 30 ] days   (0 = keep forever)
    thinking, alert pulses
                             Max size    [    ] GB   (blank = no cap)
                             Max rows    [    ]     (blank = no cap)
                             Sweep every [ 24 ] hours

  ⓘ The logged tier is supporting evidence — DNS lookups behind a shell
    command, alert-bus heartbeats. It's designed to be prunable. See
    docs/DESIGN-logged-tier-retention.md.
```

The three ceiling knobs render as blank-when-undefined so operators can see at a glance which caps are active.

### 10.2 StatusBar's chained·logged split gains a hover tooltip

Parent doc §9.4 introduces `1,234 · 89,201` for chained · logged. On the logged number, add a hover-tooltip:

```
89,201 logged rows
Oldest: 3 days ago
Retention: keep last 30 days
Next sweep: in 6h 21m
```

The "next sweep" is `now + sweepIntervalMs - (now % sweepIntervalMs)` — the tick-aligned wall-clock time. If the sweep is currently paused because `eventBus.paused`, the tooltip says `Next sweep: paused with recording`.

### 10.3 Timeline retention horizon (opt-in)

`Timeline.tsx` already renders a top-to-bottom feed of events with timestamps in the meta strip. Add an *opt-in* faint vertical line at the cutoff (`now - keepDays * 86400_000`):

```
[10:04:22]  shell.command_end     curl exploit.example.com   ⛓ signed
[10:04:11]  system.scope_violation                            ⛓ signed
─── retention horizon: 30d ago ──────────────────────────────────────  ← faint zinc-500
[10:04:07]  dns.dns_query         exploit.example.com         ⌇ logged
[10:03:58]  scanner.http_request_start                        ⌇ logged
```

Toggle in Timeline's filter chip strip. Off by default (most operators don't want the visual noise); on for auditor-view mode (parent doc §9.2).

### 10.4 First-run policy warning banner

On the first project open after v0.13 install for a project that already has *more than* `keepDays * 86400_000` old logged rows, show a one-shot banner:

```
Your logged tier includes rows older than 30 days. The v0.13 retention
policy would start pruning them on the next sweep. Adjust the policy
in Settings ▸ Retention or dismiss to proceed.
                                                 [Adjust]  [Proceed]
```

Rationale: §2.4 safety. An operator upgrading a running engagement to v0.13 gets a chance to bump `keepDays` up before the first sweep silently deletes their day-1 evidence. The "Proceed" button *does not* prevent the sweep — it just acknowledges. Rejected shape: an "delay first sweep by 24h" button. That reads as "you can procrastinate the config decision"; the correct forcing function is "decide now".

---

## 11. Migration and rollback

### 11.1 Migration

**Backfill:** none. The classifier only affects new inserts (parent doc §10.1); rows in `events_logged` are all subject to retention immediately upon v0.13 install (their `created_at` is a wall-clock ms that the sweep compares against `now - keepDays`).

**Schema change:** none. `events_logged` is already defined by the parent doc's migration; retention doesn't add columns.

**Config change:** additive. `retention.loggedTier` is a new optional block; missing = defaults from `DEFAULT_CONFIG` (which itself is a v0.13 addition per §7.1).

**Code change checklist:**

| File | Change | Section |
|---|---|---|
| `src/core/config.ts` | Add `retention.loggedTier` to `RedLogConfig` + `DEFAULT_CONFIG`; env var override in `loadConfig` | §7 |
| `src/core/retention.ts` | Add `sweepLoggedTier()` alongside `sweepRetention()`; export | §5 |
| `src/main/index.ts` | Call `sweepLoggedTier` at project-open; start periodic timer using `sweepIntervalHours` | §5.1 |
| `src/core/bundle-export.ts` | Populate `pruneWatermark` + `retentionPolicy` in manifest; extend README | §8 |
| `src/renderer/src/components/Settings.tsx` | New "Logged tier" retention section | §10.1 |
| `src/renderer/src/components/StatusBar.tsx` | Hover tooltip on the logged count | §10.2 |
| `src/renderer/src/components/Timeline.tsx` | Opt-in retention horizon line; dangling `_causes` chip | §10.3, §9.3 |
| `src/renderer/src/App.tsx` | First-run policy warning banner | §10.4 |
| `docs/event-schema.md` | Document `system.retention_pruned_logged` shape | new prose |

Every listed change is additive. No existing schema, code path, or config field changes shape.

### 11.2 Rollback

Rolling back is:

```yaml
# config.yaml
retention:
  loggedTier:
    keepDays: 0   # keep forever — matches pre-v0.13 behaviour
```

Or drop the block entirely from `config.yaml` and downgrade the app. The `events_logged` table itself stays (dropping it is the parent doc §10.2's rollback, not this doc's). No data loss — rows that were already deleted by prior sweeps are gone, but rows that survive the rollback moment are kept indefinitely.

Explicit note: **there is no "undo the last sweep" operation.** Once `sweepLoggedTier` commits, those rows are unrecoverable from the DB. This is the same shape as `sweepDir` in the existing `sweepRetention` — a deleted `.cast` file is gone. Operators who want an evidentiary snapshot ahead of a policy change take a bundle export first; the manifest's `pruneWatermark` marks their line in the sand.

### 11.3 What happens on downgrade

An operator downgrading from v0.13 to v0.12.x runs a codebase that:

- Doesn't know about `retention.loggedTier` config → ignored, no effect.
- Doesn't know about the `events_logged` table → same, ignored (it stays on disk).
- Does know about `sweepRetention` → still runs on cast/screenshot files, unchanged.

The chained tier remains fully verifiable. The `system.retention_pruned_logged` events written by v0.13 have `agent_type='system'` and a subtype v0.12 doesn't recognise, but the Timeline renderer already has a fallback for unknown subtypes, and the chain integrity walkers verify by hash regardless of subtype semantics.

---

## 12. Test plan

New tests, `test/retention/` prefix following existing conventions:

### 12.1 `test/retention/logged-sweep-total.test.ts`

- Populate `events_logged` with 5,000 rows all `created_at` well past the 30-day cutoff.
- Run `sweepLoggedTier({ keepDays: 30 }, ctx)`.
- Assert 5,000 rows deleted; assert `SELECT COUNT(*) FROM events_logged === 0`; assert `SELECT COUNT(*) FROM events` is unchanged.

### 12.2 `test/retention/logged-sweep-partial.test.ts`

- Populate 100 rows with `created_at = now - 45d`, 100 with `created_at = now - 15d`.
- Run `sweepLoggedTier({ keepDays: 30 }, ctx)`.
- Assert 100 rows remain (the 15-day-old ones); assert `min(created_at) > now - 30 * DAY_MS`.

### 12.3 `test/retention/logged-sweep-summary-event.test.ts`

- Populate 10,000 rows past the cutoff; grab pre-sweep chain head hash.
- Run sweep.
- Assert exactly one `system.retention_pruned_logged` event was inserted; assert `data.count === 10_000`, `data.oldest_deleted_at` and `newest_deleted_at` bracket the seeded window, `data.duration_ms > 0`.
- Assert `verifyChainFull()` returns `ok: true` — the new summary event chains cleanly onto the pre-sweep head.

### 12.4 `test/retention/logged-sweep-empty.test.ts`

- Empty `events_logged` table.
- Run `sweepLoggedTier({ keepDays: 30 }, ctx)`.
- Assert 0 rows deleted; assert **no** `system.retention_pruned_logged` event was inserted (§6.1 — empty sweep is a no-op).

### 12.5 `test/retention/logged-sweep-respects-pause.test.ts`

- Populate 5,000 rows past cutoff.
- Call `eventBus.pause('api')`; run `sweepLoggedTier`.
- Assert 0 rows deleted; assert no summary event fired.
- Call `eventBus.resume('api')`; run again.
- Assert 5,000 rows deleted; assert summary event fired.

### 12.6 `test/retention/logged-sweep-does-not-touch-events.test.ts`

- Populate 500 rows in `events` (chained) with `created_at = now - 45d`; 500 rows in `events_logged` same age.
- Run sweep with `keepDays: 30`.
- Assert `SELECT COUNT(*) FROM events === 500 + 1` (the +1 is the summary event); `SELECT COUNT(*) FROM events_logged === 0`.
- Explicitly asserts the `no_delete_events` trigger is NOT tripped by the sweep — the sweep's SQL string doesn't reference the `events` table at all.

### 12.7 `test/retention/logged-sweep-dangling-causes.test.ts`

- Insert a `dns.dns_query` (logged), capture its id.
- Insert a `system.scope_violation` (chained) with `_causes: [dnsId]`.
- Run sweep past the DNS row's cutoff.
- Assert `verifyChainFull()` returns `ok: true` (chained row's hash unaffected by pruned target).
- Assert `queryEventById(dnsId) === null`.
- (Renderer test, split off) Assert the scope_violation row renders with a "referenced row pruned" chip citing the retention_pruned_logged sweep whose window brackets the DNS row's `created_at`.

### 12.8 `test/retention/logged-sweep-bundle-watermark.test.ts`

- Populate 1,000 old rows, 500 recent.
- Run sweep with `keepDays: 30`.
- Export a bundle.
- Assert `manifest.pruneWatermark` equals `min(created_at)` of the 500 recent rows.
- Assert `events_logged.jsonl` contains 500 rows (not 1,500).
- Assert `manifest.retentionPolicy.keepDays === 30`.

### 12.9 `test/retention/logged-sweep-during-export.test.ts`

- Populate 20,000 rows past cutoff.
- Start a bundle export in one worker; kick off `sweepLoggedTier` in another with a 5ms delay.
- Assert the exported `events_logged.jsonl` has row count matching either the pre-sweep OR post-sweep state (not a partial mid-sweep state); assert the manifest's `pruneWatermark` matches the state in the file.

Total: 9 new tests; 3 renderer tests for the UI pieces (§10) live under `test/renderer/retention-*.test.tsx` alongside existing renderer tests.

---

## 13. Open questions

### 13.1 Does the operator get a warning before the first sweep on an existing engagement?

**Recommendation: yes, at project open.** The banner in §10.4 is the concrete answer. It only fires on the first v0.13 project open for a project whose `events_logged` table already has rows older than the policy would keep. Two follow-up subtleties:

- The banner is dismissible; dismissal is remembered per-project. It shouldn't nag on every subsequent open.
- If the operator explicitly `Adjust`s the policy from the banner and picks a keepDays value larger than the oldest row, the banner never reappears for that engagement.

Rejected: a hard-block confirm dialog. Blocking project open on a config decision is worse UX than a banner that respects the operator's ability to say "I've thought about this, proceed".

### 13.2 Do we anchor a periodic "these logged rows existed at time T" proof?

**Recommendation: no in v0.13; add a follow-up ticket.**

The audit story doesn't need it. If a reviewer wants proof "these logged rows existed at time T", the reviewer takes an OTS-timestamped bundle at time T. The bundle's `events_logged.jsonl` is what it is at that moment; the anchor covering the chained tier proves the bundle wasn't rebuilt to remove those rows without matching chain-side evidence.

For a v0.14 discussion: a periodic anchor on `SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM events_logged` (the shape §13.5 of the parent doc floated) would let a bundle taken *after* a retention sweep prove "the sweep really did delete N rows, not more, not fewer". It's a cheap addition and it composes with everything else, but it's not needed for v0.13's design to be defensible.

### 13.3 What if the operator sets `keepDays: 0` — is that "keep forever" or "delete everything"?

**Rule: `keepDays: 0` means "keep forever"** (§7.1, matching `castKeepDays: 0` and `screenshots.keepDays: 0` conventions). "Delete everything" is expressed via `keepDays: 1` combined with running the sweep; there is no shorter path.

This is a footgun-avoidance choice. `0` colliding with "immediately delete" would be a config typo that vaporises the logged tier. The convention is settled and worth honouring.

### 13.4 What about export bundles taken while a sweep is running?

**Answer: WAL isolation covers it (§8.5).** The exporter's SELECT starts at a snapshot; deletes committed after that snapshot don't affect the export. The exported bundle either reflects the pre-sweep or the post-sweep state, never a mid-sweep partial state. Test 12.9 explicitly covers this.

### 13.5 Do we bump `bundleVersion` for the manifest changes?

No. Parent doc §7.2 already bumped `bundleVersion: 1 → 2`. The `pruneWatermark` + `retentionPolicy` fields are additive to v2; a v0.13 bundle produced by an engagement that never ran a sweep will still emit both fields (with `pruneWatermark: min(created_at)` or `null` if `events_logged` is empty). External tooling reading `bundleVersion: 2` should tolerate additive fields already — that's why we bumped to 2 in the first place.

### 13.6 Do plugin authors get to set retention on their own logged-tier producers?

**Not in v0.13.** The parent doc's §13.1 allows plugin manifests to add tuples to `LOGGED_TIER`; retention on those tuples uses the global `keepDays`. Per-plugin retention overrides would need a policy-composition story ("what happens if plugin A wants 60 days and the global policy is 30?") that's out of scope here.

A follow-up ticket (`RETENTION-plugin-override`) can carry this into v0.14. First-party rule: global `keepDays` is the ceiling; a plugin cannot ask for *more* retention than the global policy allows, only less. That inversion keeps the safety story consistent.

### 13.7 Does the deconfliction webhook receive the `retention_pruned_logged` event?

Yes — same authority-tier gating as any other `system` chained event (parent doc §13.6). The webhook forwarder is authority-gated at `fact`-only by default, so most operators won't have it forwarding these; the ones who do explicitly want the sweep visible to their deconfliction endpoint.

### 13.8 What about a sudden operator-forced sweep?

Handled: `trigger: 'operator_forced'` in the summary event. Exposed via a Settings ▸ Retention "Sweep now" button that fires `sweepLoggedTier({ trigger: 'operator_forced' })` directly. The button is a convenience — the same effect happens on the next scheduled tick. Tested implicitly by the summary-event test writing all three trigger shapes.

---

## Prior art and cross-references

- The parent design this doc closes the gap in: [DESIGN-two-tier-chain.md](DESIGN-two-tier-chain.md), especially §6.2 (`_causes` semantics), §7 (bundle export), §10 (migration), §13.3 (the deferral this doc answers), §13.5 (why the sampler doesn't watch the logged tier — which is what makes retention safe here).
- The file-level retention pattern this doc extends to row-level: [`src/core/retention.ts`](../src/core/retention.ts), specifically `sweepRetention()` and `sweepDir()`.
- The append-only contract this doc deliberately does *not* violate on the chained tier: [`src/core/db/events.ts` §110–137](../src/core/db/events.ts), `assertEventsAppendOnly`.
- The v0.7.4 F2 lesson about aggressive retention defaults on evidence artifacts: [`src/main/services/agent-transcript-tailer.ts`](../src/main/services/agent-transcript-tailer.ts) and the F2 changelog entry — the reason the chained-artifact retention defaults are all 0.
- The pause contract the sweep obeys: [`src/core/event-bus.ts` §12](../src/core/event-bus.ts), `eventBus.paused`.
- The bundle export machinery this doc extends with `pruneWatermark`: [`src/core/bundle-export.ts`](../src/core/bundle-export.ts).
- The `subsystem-decomposition` framework used to enumerate the three retention axes: [MEMORY.md#decomposition-framework-suite](file:///Users/guantou/.claude/projects/-Users-guantou-Desktop-redlog/memory/decomposition-framework-suite.md).
