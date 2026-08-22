# Two-tier evidence chain: chained + logged

**Status:** proposed, targeting v0.13.0
**Author:** two-tier-chain design pass
**Prior art:** [audit-trail.md](audit-trail.md), [redaction-design.md](redaction-design.md), [event-schema.md](event-schema.md), [ROADMAP.md](ROADMAP.md)

Today every event written by RedLog runs through one path — [`insertEvent`](../src/core/db/events.ts) in `src/core/db/events.ts` — regardless of whether the row is a `shell.command_end` a subpoena will one day ask to see, or a mitmproxy `dns_query` firing at 200 events per second because the operator is running a scan. Both:

1. Get a boot-epoch-prefixed `monotonic_ns`.
2. Get canonically serialised (`canonicalStringify`) and SHA-256 hashed into `hash`.
3. Chain onto the previous row via `prev_hash`.
4. Get Ed25519-signed with the operator key (v0.6.89, cached v0.12.1).
5. Fall inside the hourly OpenTimestamps anchor window.
6. Trip clock-anomaly + chain-sample checks on every subsequent walk.

That uniformity is *the point* — it's why [audit-trail.md](audit-trail.md) can promise "any single-row edit invalidates every event after it", and why the [Ghostwriter-style sanitization boundary](redaction-design.md) works. But the price is charged evenly:

> A mitmproxy DNS query at 200/s pays the same weight as a shell command a court would subpoena.

Post-v0.12.0 the alert subsystem added producers whose whole job is to *observe* — `system.ip_verdict` unchanged-tick pulses, `system.capture_health` heartbeats, `http_request_dropped` bookkeeping. Every one of those rows currently earns a spot in the OpenTimestamps head hash. That is architecturally uniform where it shouldn't be.

This document proposes a **two-tier evidence chain** for v0.13.0: the same code path splits at the front door into a **chained** tier (unchanged: hash + Ed25519 + OTS, exactly what auditors and courts consume) and a **logged** tier (in-DB, queryable, exportable — but *not* hash-chained, *not* signed, *not* anchored). The rationale is not throughput; the rationale is *audit clarity*. A shell command that caused a DNS lookup already carries a signature and is linked via `_causes`. The DNS row itself is evidence-footprint, not evidence-artifact. Treating the two the same way makes both harder to defend.

---

## 1. Motivation

Three forces are pushing this now.

### 1.1 The alert subsystem legitimised high-frequency `system.*` producers

Before v0.12.0 the `system` lane was mostly discrete, human-scale state changes: `recording_paused`, `config_changed`, `ip_transition`, `opsec_state_changed`. Roughly one event per operator action. The v0.12.0 alert refactor introduced [`ChainEmitter`](../src/core/alert/surface.ts) — a Surface that writes every verdict from the alert bus into the chain, including the "clean" verdicts that fire on every IP tick and every scope check that resolved to in-scope. Signal producers already emit at 1–10 Hz (`ip-signal-producer`, `capture-health` pulse); a scope check per DNS query pushes another producer into the same range.

None of those rows would ever survive a "what should the auditor see?" question. They exist to *drive the alert bus* and to give the operator confidence the system is watching. Chaining and signing them, then anchoring their aggregate every hour, is over-service.

### 1.2 The legal-defence story is diluted by volume

An evidence bundle exported today includes the `system.ip_verdict` unchanged-tick row with the same `hash`, the same signature, the same OTS anchor coverage, as the `shell.command_end` where `curl exploit.example.com/rce` ran. When a bundle is 300 MB and the ip_verdict rows are 92% of it, an auditor reading `manifest.json` cannot tell at a glance which rows the chain exists *for*. The whole architecture reads as if RedLog is claiming a shell command and a heartbeat are of equal evidentiary weight — which is not the claim we want the log to make.

Cutting the tiers apart lets the bundle README say, clearly:

> The 8,142 rows in `events.jsonl` are the audit chain — every one is hash-linked, Ed25519-signed, and covered by the OTS anchor in `chain_anchors.json`. The 190,341 rows in `events_logged.jsonl` are supporting footprint (DNS lookups, capture-health pulses, alert verdicts) linked via `_causes` back into the chain. They are not signed and not anchored; treat them as investigative context, not primary evidence.

That is a *stronger* audit story than the current uniform one, because it stops asking the reader to take every heartbeat as seriously as every shell command.

### 1.3 Throughput headroom is fine — but the architecture is uniform where it shouldn't be

Prior-art guidance: this is not a performance PR. v0.12.1 cached Ed25519 keys and v0.9.8 hardened the walk-time indexes; sustained insert throughput on a modern SSD is well above the busiest producers we ship. But architectural uniformity that isn't paying its keep still costs:

- Every logged-tier row eats one spot in `computeChainHead`'s count, one entry in every future `verifyChainFull` walk, one hash to skip in every `verifyRandomSample`.
- Every logged-tier row lands in every export bundle whether the recipient asked for full evidence footprint or not.
- Every logged-tier row that touches the chain widens the window during which `chain_sample_broken` can misfire under real-world clock skew.

Fixing this at v0.13 also helps plugins, because a 🟢 trust-tier plugin that wants to log its own high-frequency observations can be pointed at the logged tier by default, without every plugin author having to think about anchor cadence.

---

## 2. Tier definitions

### 2.1 The decision rubric

Two questions, applied to every `(agent_type, subtype)` tuple:

> **Q1. Would a court, blue team, or client-side auditor ever ask for THIS specific row on its own?**
> If yes → **chained**. Full hash chain, Ed25519 signature, OTS anchor coverage.
>
> **Q2. Does this row earn its keep by being `_causes`-linked from a chained row?**
> If yes and Q1 is no → **logged**. In-DB, queryable, exportable. Not hash-chained. Not signed. Not anchored.

The rubric is designed to fail *safe*: if there's any doubt, chained wins. Downgrading a row later (chained → logged) is a semantic change that would need a version bump; upgrading (logged → chained) is a simple additive move that only affects rows written after the change.

An explicit third question guards against slow drift:

> **Q3. If we removed this producer entirely, would the chained-tier story get *worse*?**
> If yes → chained. If the answer is "the chain gets cleaner without it", it's a logged-tier candidate.

The Q3 answer for `dns_query` is *the chain gets cleaner* — the `shell.command_end` that ran `dig` already tells the audit story. The Q3 answer for `scope_violation` is *the chain gets much worse* — a redteam engagement's entire scope defence is built on those rows.

### 2.2 Chained tier (unchanged from v0.12.x)

Every one of these was a chained event today; the v0.13 change is that nothing else joins the list without an explicit decision.

| agent_type | subtype(s) | Why chained |
|---|---|---|
| `shell` | `command_start`, `command_end`, `session_start`, `session_end` | The primary evidence artifact. Every derived signal (loot, scope, pivot, cleanup) links here via `_causes`. |
| `agent` | `user_message`, `assistant_message`, `tool_call`, `tool_result`, `compact_summary`, `session_end`, `transcript_snapshot`, `transcript_compacted`, `transcript_parent_missing`, `transcript_schema_drift` | Agent turns are shell-command equivalent — the "who did this and why" record. Snapshot / schema-drift events are the chain's own proof that the transcript sidecar wasn't rewritten out from under it. |
| `screenshot` | (default) | Explicit operator capture. The paired `system.screenshot_deleted` is chained too, so retention-driven deletion stays auditable. |
| `marker` | (any) | Explicit human/agent "record this". `PAUSE_EXEMPT_AGENT_TYPES` already exempts markers from pause suppression precisely because a marker is a promise the row will land. |
| `loot` | `credential_detected` | Every loot row `_causes`-links a shell command; both need to survive verification together. |
| `cleanup` | `history_clear`, `log_clear`, `timestomp`, `file_shred` | Chain-of-custody: destroying evidence *must* itself be evidence. |
| `pivot` | `socks_up`, `port_forward`, `proxied`, `closed`, `route_add`, `tunnel_start` | Lateral movement rows — an incident-response reviewer *will* subpoena these individually. |
| `file_transfer` | `upload`, `download`, `file_created` | Data movement. Same story as pivot. |
| `browser` | `browser_launched`, opsec-relevant `navigation` | Session-genesis rows. High-frequency browser noise (see 2.3) is *not* in this row. |
| `http_navigation` | `navigation` | Top-level navigation events from CDP. Content-heavy per-request noise is logged-tier. |
| `system` | `session_start`, `api_started`, `recording_paused`, `recording_resumed`, `config_changed`, `opsec_state_changed`, `ip_transition`, `hook_auto_upgrade`, `scope_violation`, `secret_revealed`, `sanitized`, `screenshot_deleted`, `cast_pruned`, `chain_sample_broken`, `anchor_failed`, `combined_alert`, `burst_alert`, `deconfliction_test`, `agent_connect`, `attr_hide`, `interactive` | The v0.6.89 "drift detection" set from [audit-trail.md §Layer 3](audit-trail.md#layer-3-drift-detection-events). Anything a reviewer needs to distinguish "nothing happened" from "the rules were quietly changed" belongs here. |
| `system` | (embedded `_clock_anomaly` field on ANY row) | Not a separate subtype — clock anomalies land as a `data._clock_anomaly` field inside whatever row `detectClockAnomaly()` fired on. Chained by definition because the row it rides on is chained. Logged rows do NOT run the clock detector (§4.2). |

The `system` list is the one worth revisiting periodically. `combined_alert` and `burst_alert` are borderline — they're derived from other verdicts — but they carry operator-facing "the alert bus concluded" state and a reviewer reading a bundle wants them chained. If they later prove to be dominantly no-op derived rows, they graduate down to logged; that's a v0.14 conversation.

### 2.3 Logged tier (new in v0.13)

| agent_type | subtype(s) | Why logged (not chained) |
|---|---|---|
| `dns` | `dns_query`, `dns_response` | The shell command that caused the lookup is already chained and Ed25519-signed. The DNS row is causal footprint — useful for reconstructing what a scan did, not itself the evidence. Fires at scan-rate (100+/s during a `nmap` or a mass DNS pivot). |
| `scanner` | `http_request_start`, `http_response`, `http_error`, `http_request_dropped` | Same reasoning as DNS — the operator's action (curl, browser navigation, agent tool call) is chained separately. The mitmproxy addon's per-flow events are the trace, not the deed. `http_request_dropped` is pure bookkeeping (the flow *didn't* land). |
| `browser` | `console` (CDP console messages) | The `browser_launched` and top-level navigation stays chained. Per-page console spam is footprint. |
| `agent` | `thinking` | Model chain-of-thought. Already opt-in via `emitThinking` config; the rows that DO get emitted are supporting evidence for the `tool_call` that follows (which stays chained). A subpoena for what an agent *did* is answered by `tool_call`/`tool_result`; `thinking` answers *why* and can be sanitized without chain penalty. |
| `system` | `ip_verdict` when `ip_verdict_kind === 'unchanged'` (the tick-alive shape) | The IP-transition case fires as `system.ip_transition` and stays chained. `ip_verdict` fires on every IP-signal-producer tick; the unchanged-tick shape carries no state change and is pure heartbeat. |
| `system` | `capture_health` pulse (if/when we start emitting one — see §11) | Same argument as `ip_verdict` unchanged-tick. |
| `system` | `process_monitor_saturated`, `process_monitor_ps_unavailable` | Instrumentation about the process-monitor itself. Useful for debugging capture health; not evidence a reviewer needs. |
| `process` | `process_spawn`, `process_exit` | Borderline — flagged for review before v0.13 GA. Currently the process-monitor fires at ~5s poll cadence, so volume is moderate. If a shell command spawning a subprocess is the evidence, the `shell.command_end` covers it; if a *background* process (persistence beacon) is the evidence, the process rows *are* the story and should be chained. **Provisional call: logged**, with an explicit reconsider ticket if a real IR investigation ever cites one. |

### 2.4 Applying the rubric to future event types

When adding any new event source (a new hook, a new plugin, a new alert Surface):

1. Read the two-question rubric.
2. If the answer is "chained by default" — no work; `insertEvent` picks it up.
3. If the answer is "logged" — add the `(agent_type, subtype)` tuple to `LOGGED_TIER` in `src/core/db/events.ts` (§4.1).
4. If the answer isn't obvious, chained wins and a follow-up ticket goes on the docket.

Plugin-contributed event types default to **chained** (see §12) — a first-party decision to move them to logged always beats a plugin author making a snap call on evidentiary weight.

---

## 3. Schema shape

Two options were considered.

### 3.1 Option A: `chained BOOLEAN` column on existing `events` table

Add one column, flip a flag per row. Query paths need a `WHERE chained = 1` (or `= 0`) filter; the append-only triggers stay; the walk-time verifier adds a `WHERE hash IS NOT NULL AND chained = 1` filter.

**Pros:**
- Zero migration for existing rows (they're all `chained = 1` by default).
- One table means one pager anchor for Timeline.
- Simplest read path (`SELECT * FROM events` still works).

**Cons — and why this is not the recommendation:**
- Every index on `events` today ([db/index.ts §46–80](../src/core/db/index.ts)) is sized for the chained-tier row shape (small `data` blobs, ~1–10 rows per second). Adding logged-tier rows into the same table by 10–100× would blow the row-count assumptions behind `idx_events_type_ts` and `idx_events_hashed` — both were sized (v0.9.8) against real 131k-row engagements.
- The append-only trigger `no_update_events_hash` was designed for a schema where every row participates in chain integrity. Extending it to skip logged rows would either weaken the trigger (bad) or force logged rows to also be immutable (over-service — logged-tier rows should be freely prunable by retention).
- Retention becomes muddled: retention-driven DELETE on logged rows would need to bypass `no_delete_events`, and once that bypass exists it's one grep away from being reused wrongly on chained rows.
- Bundle export ([bundle-export.ts §80](../src/core/bundle-export.ts)) currently iterates the whole `events` table into `events.jsonl` — that file would need a filter and lose its "this file IS the chain" property.

### 3.2 Option B: separate `events_logged` table — **recommended**

A dedicated table for the logged tier, mirroring `events` but stripped of chain-integrity columns:

```sql
CREATE TABLE IF NOT EXISTS events_logged (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  operator_id   TEXT NOT NULL,
  agent_type    TEXT NOT NULL,
  hostname      TEXT NOT NULL DEFAULT '',
  source_ip     TEXT,
  target_id     TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
  -- Deliberately absent: prev_hash, hash, signature, monotonic_ns, ntp_offset_ms.
  -- The tier is defined by the absence of chain columns — a row in this table
  -- CANNOT be chained, and every reader that unions the two tables discovers
  -- that at compile time (no `hash` field to reference).
);

CREATE INDEX IF NOT EXISTS idx_events_logged_ts        ON events_logged(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_logged_type_ts   ON events_logged(agent_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_logged_engagement ON events_logged(engagement_id);
CREATE INDEX IF NOT EXISTS idx_events_logged_target    ON events_logged(target_id);
CREATE INDEX IF NOT EXISTS idx_events_logged_created_at ON events_logged(created_at);
```

Notably **absent**:
- No `no_delete_events_logged` trigger — retention CAN and SHOULD prune the logged tier (an engagement doing 200 DNS queries/second for a week generates ~120M rows; the chained tier at 1-10 events/second on the same engagement generates ~6M).
- No `no_update_events_logged_hash` trigger — nothing to protect.
- No `hash`, `prev_hash`, `signature`, `monotonic_ns`, `ntp_offset_ms` columns. A logged-tier row does not participate in the chain; those columns would be permanently NULL and would mislead the schema reader.

**Pros:**
- Chain-integrity contract on `events` stays exactly the same. Every existing trigger, index, walker, sampler, and anchor code path keeps its current invariants.
- Retention on the logged tier is a straight `DELETE ... WHERE created_at < ?` — no trigger to bypass.
- Bundle export writes two files (`events.jsonl` + `events_logged.jsonl`), and the "this file is the chain" property of `events.jsonl` is preserved.
- Schema diff is 100% additive; drop the table and every current code path still works. See §10.

**Cons — and why they're acceptable:**
- `queryEvents` now unions two sources. Because SQLite handles `UNION ALL` between shape-compatible SELECTs efficiently and both tables have `(agent_type, timestamp DESC)` composite indexes, the cost is minimal (§5). The union is confined to `db/events.ts`; no caller sees it.
- Two indexes to keep sized. Cheap.
- Two triggers to think about (`events` keeps its append-only pair; `events_logged` deliberately has none). Fewer, not more, semantic states.

**Recommendation: Option B.** Separate table, additive migration. The extra 5 lines in `queryEvents` are worth keeping the append-only contract on `events` inviolate.

### 3.3 Migration SQL (applied in `initDB`)

```sql
-- v0.13.0 additive: logged-tier evidence footprint. NOT hash-chained;
-- NOT signed; NOT covered by OTS anchor. Rows here are supporting
-- evidence for chained events (linked via _causes) — the DNS lookup
-- behind a shell command, the CDP console line behind a browser row,
-- the ip_verdict tick behind an ip_transition. See docs/DESIGN-two-tier-chain.md.
CREATE TABLE IF NOT EXISTS events_logged (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  operator_id   TEXT NOT NULL,
  agent_type    TEXT NOT NULL,
  hostname      TEXT NOT NULL DEFAULT '',
  source_ip     TEXT,
  target_id     TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_logged_ts         ON events_logged(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_logged_type_ts    ON events_logged(agent_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_logged_engagement ON events_logged(engagement_id);
CREATE INDEX IF NOT EXISTS idx_events_logged_target     ON events_logged(target_id);
CREATE INDEX IF NOT EXISTS idx_events_logged_created_at ON events_logged(created_at);
```

Idempotent — safe to call every project open, matches the [pattern in `src/core/db/index.ts`](../src/core/db/index.ts).

---

## 4. `insertEvent` dispatch

The classifier is a static function that maps `(agent_type, subtype)` to `'chained' | 'logged'`. Same shape as the existing `PAUSE_EXEMPT_AGENT_TYPES` set in `src/core/db/events.ts` — keyed at module load, no per-call allocation.

### 4.1 The classifier

```ts
// src/core/db/events.ts — additions

/** Static tier lookup. Every real (agent_type, subtype) pair emitted by
 *  RedLog must resolve here to exactly one tier — the tier_classifier_total
 *  test (§11) enforces that. Anything not listed defaults to `'chained'`
 *  by policy: unknown-source rows are treated as high-value evidence
 *  until an operator explicitly opts them into the logged tier. Plugin
 *  authors adding a new (agent_type, subtype) that should be logged must
 *  add it here as part of the same PR. */

// (agent_type, subtype) tuples that write to events_logged instead of events.
// Anything else — including missing subtype — goes chained.
const LOGGED_TIER: ReadonlySet<string> = new Set([
  // mitmproxy DNS producer (agent_type=dns from hooks/mitmproxy-addon.py)
  'dns:dns_query',
  'dns:dns_response',

  // mitmproxy HTTP producer (agent_type=scanner)
  'scanner:http_request_start',
  'scanner:http_response',
  'scanner:http_error',
  'scanner:http_request_dropped',

  // CDP browser console messages. NOTE: browser_launched and top-level
  // navigation stay CHAINED — they're session-genesis rows.
  'browser:console',

  // Agent chain-of-thought — the tool_call that follows is chained.
  'agent:thinking',

  // Process-monitor self-instrumentation. process_spawn/process_exit
  // are provisionally logged; §2.3 flags the reconsider ticket.
  'process:process_spawn',
  'process:process_exit',
  'system:process_monitor_saturated',
  'system:process_monitor_ps_unavailable',
])

// system.ip_verdict is a special case — the tier depends on a data field,
// not the subtype alone. `ip_verdict_kind === 'unchanged'` is a
// tick-alive heartbeat; anything else is a real state change that
// belongs alongside system.ip_transition in the chain.
function isLoggedTierIPVerdict(agentType: string, data: Record<string, unknown>): boolean {
  return agentType === 'system'
    && data.subtype === 'ip_verdict'
    && data.ip_verdict_kind === 'unchanged'
}

/** Classify a would-be event into chained (default) or logged tier.
 *  Called at the top of insertEvent — see §4.2 for the dispatch. */
export function classifyTier(
  agentType: string,
  data: Record<string, unknown>
): 'chained' | 'logged' {
  const subtype = typeof data.subtype === 'string' ? data.subtype : ''
  if (LOGGED_TIER.has(`${agentType}:${subtype}`)) return 'logged'
  if (isLoggedTierIPVerdict(agentType, data)) return 'logged'
  return 'chained'
}
```

### 4.2 The dispatch in `insertEvent`

The current `insertEvent` becomes a two-arm dispatch. The chained arm is the *entire* body of today's function, unchanged. The logged arm is a much shorter path — no hash, no signature, no clock-anomaly detector, no chain-cache mutation.

```ts
export function insertEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string; bypassPause?: boolean }
): RedLogEvent | null {
  // Pause enforcement stays at the front door — same behaviour for both tiers.
  // (system + marker exempt; bypassPause overrides.)
  if (!PAUSE_EXEMPT_AGENT_TYPES.has(agentType) && !opts?.bypassPause && eventBus.paused) return null

  const tier = classifyTier(agentType, data)
  if (tier === 'logged') return insertLoggedEvent(agentType, data, opts)
  return insertChainedEvent(agentType, data, opts)  // ← everything currently in insertEvent
}

function insertLoggedEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts?: { engagementId?: string; operatorId?: string; targetId?: string }
): RedLogEvent | null {
  if (!opts?.operatorId) {
    throw new Error(`insertEvent (logged): operatorId is required (agent_type=${agentType}). ` +
      `Every event must resolve to a known operator — see docs/operators.md.`)
  }
  const db = getDB()
  const now = Date.now()
  const event: RedLogEvent = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts.engagementId ?? 'default',
    sessionId,
    operatorId: opts.operatorId,
    agentType,
    hostname: os.hostname(),
    sourceIP: null,
    targetId: opts.targetId ?? null,
    data,
    createdAt: now,
    // Deliberately absent: hash, prevHash, signature, monotonicNs, ntpOffsetMs.
    // Callers that read RedLogEvent must treat these as always-null on logged rows.
    hash: undefined,
    prevHash: null,
    monotonicNs: null,
    ntpOffsetMs: null,
    signature: null
  }
  db.prepare(`
    INSERT INTO events_logged
      (id, timestamp, engagement_id, session_id, operator_id, agent_type,
       hostname, source_ip, target_id, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.timestamp, event.engagementId, event.sessionId,
    event.operatorId, event.agentType, event.hostname, event.sourceIP,
    event.targetId, JSON.stringify(event.data), event.createdAt
  )
  return event
}
```

The logged path deliberately does **not**:

- Update the `cachedLastHash` cache (there's no chain contribution).
- Update the `cachedEventCount` cache (that count is chain-scoped — the anchor uses it).
- Run `detectClockAnomaly` (clock anomalies are only meaningful on rows the chain will one day rehash).
- Compute canonical JSON or sign anything.
- Enter the shell-command dedup window (dedup is a chained-tier concern; logged rows are inherently high-volume and dedup would cost more than it saves).

**Note on `RedLogEvent`:** the interface keeps every field. Logged rows return with the chain-related fields set to null/undefined. Any caller that reads `event.hash` on a logged row and expects a value has a bug the tier classifier just exposed — that's the design intent, not a regression.

### 4.3 The event bus stays uniform

Both chained and logged rows continue to publish through `eventBus.publish(evt)`. Renderer subscribers get *both* streams. The tier is a persistence concern, not a subscription concern. The subscriber that needs to filter (Timeline's auditor view, §7) does so based on `evt.hash != null` or an explicit `evt.tier` field the row-mapper stamps in (§5.2).

---

## 5. Reader path: `queryEvents`

### 5.1 The union

The two tables have compatible shapes minus the chain columns. The union is straightforward:

```ts
export function queryEvents(opts: {
  agentType?: string
  limit?: number
  since?: number
  before?: number
  beforeCreatedAt?: number
  targetId?: string
  excludeHousekeeping?: boolean
  /** v0.13: which tier(s) to include. Default is 'all' — the operator's
   *  timeline shows both. The chained-only mode is what the auditor view
   *  and the bundle verifier consume. */
  tier?: 'all' | 'chained' | 'logged'
}): RedLogEvent[] {
  const db = getDB()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agentType) { conditions.push('agent_type = ?'); params.push(opts.agentType) }
  if (opts.since)     { conditions.push('timestamp >= ?'); params.push(opts.since) }
  if (opts.before)    { conditions.push('timestamp < ?');  params.push(opts.before) }
  if (opts.beforeCreatedAt) { conditions.push('created_at < ?'); params.push(opts.beforeCreatedAt) }
  if (opts.targetId)  { conditions.push('target_id = ?');  params.push(opts.targetId) }
  if (opts.excludeHousekeeping) conditions.push(HOUSEKEEPING_SQL)

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 200
  const tier = opts.tier ?? 'all'

  // v0.13: build one SELECT per participating tier and UNION ALL.
  // Both tables carry the same shape for these columns (hash + signature
  // + monotonic_ns are NULL on logged rows and typed on chained rows).
  const chainedSelect = `
    SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data, hash, prev_hash, created_at,
           monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
    FROM events ${where}
  `
  const loggedSelect = `
    SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data,
           NULL AS hash, NULL AS prev_hash, created_at,
           NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
           'logged' AS tier
    FROM events_logged ${where}
  `

  let sql: string
  let bind: unknown[]
  if (tier === 'chained') { sql = `${chainedSelect} ORDER BY timestamp DESC LIMIT ?`; bind = [...params, limit] }
  else if (tier === 'logged') { sql = `${loggedSelect} ORDER BY timestamp DESC LIMIT ?`; bind = [...params, limit] }
  else {
    sql = `SELECT * FROM (${chainedSelect} UNION ALL ${loggedSelect})
           ORDER BY timestamp DESC LIMIT ?`
    bind = [...params, ...params, limit]
  }

  const rows = db.prepare(sql).all(...bind) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
}
```

Performance notes:
- `SELECT * FROM (A UNION ALL B) ORDER BY timestamp DESC LIMIT N` in SQLite materialises both selections, sorts, then limits. On paper this is worse than an index-driven top-N — in practice both `idx_events_ts` and `idx_events_logged_ts` deliver rows already-ordered, so the outer sort is a k-way merge over two already-sorted inputs (essentially free).
- If a real engagement grows logged-tier to 10M+ rows and the Timeline pager feels the difference, we can move to per-tier pagers and a k-way merge in JS. That's a v0.14 problem, not a v0.13 problem.

### 5.2 `rowToEvent` learns about `tier`

```ts
function rowToEvent(row: Record<string, unknown>): RedLogEvent {
  return {
    ...existingFields,
    hash:      row.hash as string | null,
    prevHash:  (row.prev_hash as string | null) ?? null,
    signature: (row.signature as string | null) ?? null,
    tier:      (row.tier as 'chained' | 'logged' | undefined) ?? 'chained'  // ← new
  }
}
```

`tier` is an OPTIONAL new field on `RedLogEvent`. Consumers that don't set it default to `'chained'`, so existing code that constructs a `RedLogEvent` by hand keeps working.

### 5.3 `queryEventById` looks up in both tables

Chained wins on collision (UUIDs never collide, but if they did the chained answer is authoritative):

```ts
export function queryEventById(id: string): RedLogEvent | null {
  const db = getDB()
  const chained = db.prepare('SELECT * FROM events WHERE id = ? LIMIT 1').get(id) as Record<string, unknown> | undefined
  if (chained) return rowToEvent({ ...chained, tier: 'chained' })
  const logged = db.prepare('SELECT * FROM events_logged WHERE id = ? LIMIT 1').get(id) as Record<string, unknown> | undefined
  return logged ? rowToEvent({ ...logged, tier: 'logged' }) : null
}
```

### 5.4 `getEventCount` — chained-only

The chain-anchor code reads `getEventCount` to size the head hash. That count MUST stay chained-only or every anchor breaks. Change:

```ts
export function getEventCount(opts?: { tier?: 'chained' | 'logged' | 'all' }): number {
  const tier = opts?.tier ?? 'chained'   // ← default preserved for anchor callers
  ...
}
```

Every existing call site already means "chained count" so no change needed at the call site. The renderer's StatusBar tick can be updated to show `getEventCount({ tier: 'all' })` if we want the row-count number to include footprint; more likely we show two: `1,234 chained · 89,201 logged`.

---

## 6. Verifier semantics

### 6.1 `verifyChainFull` walks only chained rows

Trivially. The walk SQL is scoped to `FROM events`; `events_logged` is a separate table and therefore invisible. No code change needed in [chain-anchor.ts §810](../src/core/chain-anchor.ts).

That is the *point*. An auditor running `redlog-cli chain verify` (or the bundled `redlog-verify.py`) walks the same rows they always did, gets the same result, and the OTS anchor covers the same head.

### 6.2 `_causes` between tiers — the rule

`_causes` is a soft causal pointer. Today every `_causes` reference points from a derived chained row (`loot.credential_detected`, `system.scope_violation`) to an upstream chained row (a `shell.command_end` or `scanner.http_request_start`). The chain hash walks make no claim that `_causes` targets exist or verify; they're breadcrumbs for the human reader and for `causes-resolver`.

Post-v0.13:

- **chained → chained**: unchanged, no rule change.
- **chained → logged**: **ALLOWED**. Example: a `system.scope_violation` (chained) whose `_causes` points at the underlying `dns.dns_query` (logged) row. The chain integrity of the scope_violation row is unaffected — its hash covers its own data field, including the `_causes` array of ids. The claim the row is making is "here are strings I stored", not "here are rows I can promise exist". If someone later prunes the logged row, the id string in `_causes` becomes a dangling pointer — that's a UI concern, not a chain-integrity concern.
- **logged → chained**: **ALLOWED**. Example: a `scanner.http_request_start` (logged) whose `_causes` points at the `shell.command_start` that ran `curl` (chained). Same soft pointer.
- **logged → logged**: **ALLOWED**. Example: `scanner.http_response` linking `scanner.http_request_start` via `flow_id` → `_causes`. No chain claim either way.

There is one rule that IS enforced:

> **A row's `hash` MUST cover its own `_causes` field regardless of tier.** For chained rows this is automatic — `canonicalStringify` includes `_causes` because it's inside `data`. For logged rows there is no hash, so nothing to enforce, but the shape is preserved so a future promotion (logged → chained) doesn't need a data migration.

### 6.3 `verifyRandomSample` — chained-only

Also trivially unchanged. `verifyRandomSample` queries `events` (see [chain-anchor.ts §927](../src/core/chain-anchor.ts)); the logged tier is out of scope. This means the background sampler ticker (5 min in [main/index.ts §655](../src/main/index.ts)) does NOT sample logged rows.

**Should it?** No. The sampler exists to catch chain-aware tampering — an attacker who edits rows, recomputes hashes, and updates the anchor. Logged rows have no hashes to verify against, so there is nothing to detect. The equivalent check for logged rows would be a row-count consistency proof, which is a separate feature we don't need at v0.13.

### 6.4 The bundled `redlog-verify.py` verifier

The Python verifier ([tools/redlog-verify.py](../tools/redlog-verify.py), shipped inside every export bundle since v0.6.94) reads `events.jsonl`. In v0.13 the bundle also carries `events_logged.jsonl` (§7) — the verifier IGNORES it. Its output line becomes:

```
Walked 8,142 chained events (chain intact).
Logged tier: 190,341 rows present in events_logged.jsonl (not verified — supporting evidence).
Signatures: 8,140 verified, 2 unsigned (pre-v0.6.89 rows).
Anchor: OTS receipt covers head hash abc123... (event count 8,142).
```

That single "not verified — supporting evidence" line does more for the audit story than any amount of chain-throughput tuning.

---

## 7. Export bundle

### 7.1 Layout

The bundle keeps its current top-level structure with one addition:

```
bundle-2026-08-18T14-30-00/
├── manifest.json                 ← lists both files; distinguishes tiers
├── manifest.sha256
├── manifest.hmac                 ← primary operator's HMAC over manifest
├── events.jsonl                  ← chained tier, unchanged
├── events_logged.jsonl           ← NEW: logged tier, in insertion order
├── quickmarks.json
├── chain_anchors.json
├── operators.json
├── screenshots/
├── casts/
├── agent-transcripts/            ← opt-in, unchanged
├── redlog-verify.py              ← ignores events_logged.jsonl
├── verify.sh
├── verify.cmd
└── README.md                     ← updated per §7.3
```

### 7.2 Manifest changes

The `ManifestPayload` in [bundle-export.ts §22](../src/core/bundle-export.ts) grows one field:

```ts
interface ManifestPayload {
  bundleVersion: 2                            // ← bumped
  ...
  chainHead: ...                              // unchanged; still chained-only
  lastAnchor: ...                             // unchanged; still chained-only
  sanitized: { events: number; totalInDb: number }
  /** v0.13: row counts per tier. `chained` matches chainHead.eventCount
   *  (that is the definitional count the anchor covers); `logged` is the
   *  events_logged row count included in this bundle. */
  tiers: { chained: number; logged: number }  // ← NEW
  files: ManifestFile[]
}
```

A bundle-version bump (`1 → 2`) signals the layout change to any external tooling that unpacks bundles. The bundled `redlog-verify.py` accepts both versions.

### 7.3 The README rewrite

The `README.md` written into every bundle by [bundle-export.ts §244](../src/core/bundle-export.ts) gains a "What's in this bundle" section that spells out the two-tier story explicitly:

```
# RedLog evidence bundle

## What's in this bundle

- **events.jsonl** — the audit chain. Every row is SHA-256-linked to the
  previous row, Ed25519-signed by the operator's key, and covered by the
  OpenTimestamps anchor in chain_anchors.json. This is what auditors and
  courts should treat as primary evidence.

- **events_logged.jsonl** — supporting footprint. DNS lookups, HTTP flow
  bookkeeping, CDP console lines, alert-verdict pulses. Linked back into
  events.jsonl via `_causes` where a causal relationship is known. NOT
  hash-chained, NOT signed, NOT anchored. Treat as investigative context.

## Verify (macOS / Linux)
  bash verify.sh

## Verify (Windows)
  verify.cmd

The verifier walks events.jsonl only; the logged tier is present for
completeness but not verified.
```

### 7.4 Sanitization

Layer-4 redaction ([redaction-design.md](redaction-design.md)) currently applies only to the chained tier — the `sanitized_events` table is indexed by `source_event_id` where the source is a chained row. In v0.13 the sanitize CLI also gets pointed at logged-tier rows for the same reasons (a DNS query can carry credentials in a URL). Because logged rows have no chain hash, sanitization there is a straight overwrite in `events_logged.jsonl` at export time — no `system.sanitized` audit event needs to fire (the logged tier is not itself audit-grade).

**Correction:** the `system.sanitized` event SHOULD still fire (it lands on the chained tier, so an auditor sees "at export time, N rows in events_logged.jsonl were also sanitized"), but the sanitization payload for a logged row bypasses the `sanitized_events` table — a straight in-memory rewrite is enough, since there's nothing to reconcile against a hash.

---

## 8. OTS anchor

**Unchanged.** `computeChainHead`, `anchorNow`, `startAnchorLoop`, `verifyLatestAnchor` all read from the `events` table (chained-tier only). The head hash formula stays `SHA256(latest_hash || event_count)`; `event_count` is unambiguously the chained count (see §5.4).

There is no need to anchor the logged tier. If we ever want to prove "these logged rows existed at time T" for a specific engagement, the honest answer is: run them through the sanitized-export-then-hash path and get an OTS timestamp on the exported bundle. That's already possible today and doesn't require the online anchor loop to change.

---

## 9. Renderer / UI

### 9.1 The tier badge on Timeline cards

Every row in Timeline gets a tiny tier marker in its meta strip. The chained badge is subtle — it's the default — and the logged badge is more visible so the operator understands "this row is for context, not audit".

- **Chained**: a single hair-thin `⛓` glyph next to the row's timestamp. No colour. Almost invisible until you look for it. Serves as the visual assertion "this is on the chain".
- **Logged**: an outline `⌇` glyph tinted zinc-500. Slightly softer visual weight than a chained row.

Rows already carry chain-broken (`⛓️‍💥`) and sample-broken badges (see [Timeline.tsx §616](../src/renderer/src/components/Timeline.tsx)). The tier badge sits in the same badge stack, at the leftmost position, so it reads as the primary classifier.

### 9.2 The auditor-view filter chip

A new filter chip in the Timeline toolbar: **"Auditor view"**. When active:

- Only chained rows render.
- The `CaptureHealthCard` [in App.tsx §329](../src/renderer/src/App.tsx) shows two figures: total captured events (both tiers) *and* audit-tier events (chained only).
- The bundle-export dialog defaults to including the logged tier but shows a clear "Chained-tier only (audit view)" toggle.

The chip is off by default. Operators want to see everything by default; auditors flip it on before reviewing.

### 9.3 The adherence counter (chained-only)

`AdherenceCounter` in [alert/surface.ts §262](../src/core/alert/surface.ts) is a Surface that consumes `Verdict` streams from the alert bus. Those verdicts get emitted through the ChainEmitter into `system.scope_violation` rows, which are chained. Adherence therefore stays chained-tier by construction — no change.

### 9.4 The StatusBar row counter

The tiny StatusBar row-count tick becomes `1,234 · 89,201` (chained · logged) to make the two tiers visually present at all times. Clicking the number opens the filter chip.

### 9.5 The chain-health card

The Settings panel's chain-integrity readout ([Settings.tsx §2188](../src/renderer/src/components/Settings.tsx)) already reads `chainHead.eventCount`. That number continues to be chained-only. A new line below it displays logged-tier count and last-fed timestamp, so the operator can tell "is my mitmproxy feeding logged rows too, or is only the chained tier active?".

---

## 10. Migration and rollback

### 10.1 Migration

**Backfill:** none. Every row in `events` today is chained-tier by definition; the classifier only affects new inserts after the v0.13 update runs. Rows written pre-v0.13 stay in `events` and continue to verify under the existing shape ladder in `verifyRowHash`.

**Schema change:** additive only — one `CREATE TABLE IF NOT EXISTS events_logged` + five indexes. See §3.3 for the SQL.

**Code change checklist:**

| File | Change | Section |
|---|---|---|
| `src/core/db/index.ts` | Add `events_logged` CREATE TABLE + indexes in `initDB` | §3.3 |
| `src/core/db/events.ts` | Split `insertEvent` into tier dispatch + `insertLoggedEvent`; add `classifyTier`; extend `queryEvents` with `tier` option; teach `queryEventById` about both tables; extend `getEventCount` with `tier` option (default chained) | §4, §5 |
| `src/core/chain-anchor.ts` | No change — walks `events` only | §6 |
| `src/core/evidence-chain.ts` | No change — counts `events.hash IS NOT NULL` only | §6 |
| `src/core/bundle-export.ts` | Add `events_logged.jsonl` writer; bump `bundleVersion` to 2; extend `ManifestPayload` with `tiers`; rewrite bundle README | §7 |
| `tools/redlog-verify.py` | Recognise `bundleVersion: 2`; skip `events_logged.jsonl` with a summary line | §6.4 |
| `src/renderer/src/components/Timeline.tsx` | Add tier badge; add auditor-view filter chip | §9 |
| `src/renderer/src/App.tsx` | Extend `CaptureHealthCard` to show tier split | §9.5 |
| `src/renderer/src/components/StatusBar.tsx` | Row-count becomes `chained · logged` | §9.4 |
| `src/renderer/src/components/Settings.tsx` | Chain-integrity readout gains logged-tier line | §9.5 |
| `docs/audit-trail.md` | Add "Two tiers" section pointing at this doc | new prose |
| `docs/event-schema.md` | Every listed event type annotated with its tier | new column |

### 10.2 Rollback

Drop the table:

```sql
DROP TABLE IF EXISTS events_logged;
```

Every code path against `events_logged` is confined to the files enumerated above. Reverting the code and dropping the table restores exact pre-v0.13 behaviour — no chained-tier row was ever touched, no anchor was recomputed, no signature verifier changed.

The one lossy step: any logged-tier row written between the v0.13 install and rollback is gone. That's the point — those rows were declared non-audit-grade at write time.

---

## 11. Test plan

New tests, all in `test/` following the existing pattern:

### 11.1 `test/db/tier-classifier.test.ts`

- **totality**: for every `(agent_type, subtype)` pair actually emitted anywhere in `src/**/*.ts` (extracted by grep — the same list §2 was built from), assert `classifyTier(agent_type, { subtype })` returns exactly one of `'chained' | 'logged'`. Fails loudly if a new pair is added without a tier decision.
- **default is chained**: for a made-up `(agent_type, subtype)` pair not in `LOGGED_TIER`, assert `'chained'`.
- **ip_verdict special case**: `system.ip_verdict` with `ip_verdict_kind: 'unchanged'` returns `'logged'`; with `ip_verdict_kind: 'ip_changed'` returns `'chained'`.
- **subtype absent**: `system` with no subtype returns `'chained'` (unknown pairs fail safe).

### 11.2 `test/db/logged-insert.test.ts`

- `insertEvent('dns', { subtype: 'dns_query', ... })` lands in `events_logged` and returns an event with `hash === undefined`, `signature === null`.
- The same call does NOT bump `cachedLastHash`, does NOT bump the chained event count, does NOT run the clock-anomaly detector.
- `insertEvent('shell', { subtype: 'command_end', ... })` right after lands in `events` and chains onto the true chain head (i.e. the DNS row in between did not corrupt the chain).

### 11.3 `test/chain/verify-ignores-logged.test.ts`

- Insert 10 chained rows, 100 logged rows interleaved, another 10 chained rows.
- `verifyChainFull()` returns `ok: true, walked: 20` (only chained rows).
- `verifyRandomSample(50)` returns `ok: true, sampled ≤ 20` (only chained rows exist to sample).

### 11.4 `test/bundle/two-tier-export.test.ts`

- Export a bundle with both tiers populated.
- Both `events.jsonl` and `events_logged.jsonl` exist.
- `manifest.json` `bundleVersion === 2` and `tiers` is populated with correct counts.
- Running `python3 redlog-verify.py <bundleDir>` exits 0 and prints the "logged tier: N rows present" line.

### 11.5 `test/causes/cross-tier-links.test.ts`

- Insert a `dns.dns_query` (logged) whose id is captured.
- Insert a `system.scope_violation` (chained) with `_causes: [dnsId]`.
- Assert `verifyChainFull()` returns `ok: true` — the chained row's `_causes` field is inside its hashed `data`, but the chain integrity check does NOT dereference `_causes`.
- Assert `queryEventById(dnsId).tier === 'logged'`.

### 11.6 `test/renderer/timeline-tier-badge.test.tsx`

- Rows render with the correct tier badge (`⛓` chained, `⌇` logged).
- Auditor view filter hides logged rows.

### 11.7 `test/migration/schema-drop-and-recreate.test.ts`

- Run `initDB` on an empty projectDir → assert `events_logged` table exists.
- `DROP TABLE events_logged` → run `initDB` again → assert it's recreated with the correct indexes (idempotency).

---

## 12. Rollout

**Hard cut on v0.13.0.** No feature flag.

The audit story materially changes at this switch: bundles look different, the verifier's summary line changes, the Timeline gains a badge. A feature flag would mean an intermediate universe where `events_logged` exists on-disk but half the code doesn't know about it — that's exactly the kind of split-brain state a chain-integrity feature cannot tolerate.

The major bump is warranted by:
- Bundle format bumps from `bundleVersion: 1` to `2`.
- Any external tooling that consumes RedLog bundles (rare but possible) needs to be aware of `events_logged.jsonl`.
- The RedLog CLI grows `--tier chained|logged|all` flags on the query/export commands.

Every pre-v0.13 row stays chained; verification of pre-v0.13 bundles under the v0.13 verifier is unchanged.

Release note draft (for CHANGELOG.md):

> **v0.13.0 — Two-tier evidence chain**
>
> The audit chain now has a clearer story. Shell commands, agent turns,
> markers, loot, cleanup, pivots, and scope violations continue to be
> hash-chained, Ed25519-signed, and OTS-anchored — the primary evidence
> tier. DNS lookups, HTTP flow bookkeeping, CDP console messages, agent
> thinking, and alert-bus heartbeats now write to a separate `events_logged`
> table — the supporting-footprint tier. Bundles carry both as separate
> files (`events.jsonl` + `events_logged.jsonl`); the verifier walks the
> chained tier only. See docs/DESIGN-two-tier-chain.md.

---

## 13. Open questions

### 13.1 Plugin-contributed event types default to which tier?

**Recommendation: chained.** A 🟢-trust plugin that emits `insertEvent('my-plugin', {...})` should land chained by default. Plugin authors can opt into logged tier by extending `LOGGED_TIER` in a plugin manifest field:

```yaml
# plugin.yaml
logged_tier_events:
  - my-plugin:heartbeat
  - my-plugin:trace
```

The plugin loader merges the manifest set into `LOGGED_TIER` at load time. Manifest merges are additive — a plugin cannot demote a first-party chained tuple to logged.

### 13.2 Legacy events pre-v0.13 stay chained (correct)

Rows in `events` written before v0.13 remain hash-linked, signed (if the operator had a key), and covered by whatever OTS anchor existed at write time. The tier classifier only affects new inserts. This is exactly the desired behaviour — a chain rewrite would defeat the point of the chain.

### 13.3 Retention on the logged tier

Not addressed in v0.13. The logged tier will grow unboundedly by default; a follow-up ticket (`RETENTION-logged-tier`) needs to:

- Extend `src/core/retention.ts` with a logged-tier sweep.
- Emit `system.retention_pruned_logged` chained events summarising the sweep (count, oldest, newest, disk reclaimed).
- Default retention: "keep last 30 days of logged tier". Configurable per-project.

Deferred because the retention design intersects the ScopeStatus + CaptureHealth policy questions in a way that's worth its own doc.

### 13.4 Does the logged tier get its own dedup?

No. The chained-tier shell/agent dedup at [events.ts §268–313](../src/core/db/events.ts) is a chained-tier concern (it protects the chain from paired hook noise). Logged-tier producers (mitmproxy, CDP) already dedup upstream — mitmproxy emits one row per flow, the CDP connector emits one per console message. If a future producer needs dedup, that's a producer-side responsibility, not the tier's.

### 13.5 Does `verifyChainFull` need a "logged tier row count sanity check"?

Not in v0.13. The value would be catching a silent DELETE from `events_logged` — but the logged tier is designed to be prunable, so DELETE is a first-class operation there. A hostile actor deleting logged rows is deleting supporting evidence, not primary evidence; the chained scope_violation row survives.

If a future audit requirement asks "prove no logged rows were deleted", the answer is a separate periodic OTS anchor on `SELECT COUNT(*), MAX(rowid), MAX(created_at) FROM events_logged` — cheap, additive, doesn't require touching the chained-tier anchor.

### 13.6 Does the deconfliction webhook forward logged rows?

No. `WebhookForwarder` in [alert/surface.ts §182](../src/core/alert/surface.ts) is authority-tier gated (default `fact`-only). The logged-tier ip_verdict unchanged-tick rows are not verdicts the alert bus surfaces upward; they're heartbeats the ChainEmitter should stop writing (§2.3). WebhookForwarder gets less noise, not more, from this change.

### 13.7 Should `queryEventById` return `tier: 'chained'` even for a logged-table row that shares an id with a chained row?

Impossible in practice (UUIDs), but the code in §5.3 picks chained-first anyway, which is the safe default: if there's ever any ambiguity, the chained answer is the one an auditor gets.

---

## Prior art and cross-references

- The uniform-chain premise this doc revises: [audit-trail.md](audit-trail.md), specifically Layer 1 and Layer 3.
- The four-layer redaction pattern this doc mimics (additive events, source-of-truth preservation): [redaction-design.md](redaction-design.md).
- The alert-subsystem seam that made this refactor legible: `src/core/alert/{signal,policy,surface}.ts` and the v0.12.0 release.
- The `subsystem-decomposition` pattern used to enumerate the tiers: [MEMORY.md#decomposition-framework-suite](file:///Users/guantou/.claude/projects/-Users-guantou-Desktop-redlog/memory/decomposition-framework-suite.md).
- The v0.6.89 `_causes` design ([causes-resolver.ts](../src/core/causes-resolver.ts)) — untouched by this change, but the "chained cites logged" case §6.2 relies on `_causes` semantics.
