// Running a scope recompute against a real project (design turn 8a).
//
// The decision lives in scope-recompute.ts, which knows nothing about SQLite.
// This is the join: find which targets the boundary change actually affects,
// hydrate only those rows, ask the planner what to append, and append it — the
// same split retention.ts uses between `planEviction` and `sweepBodyStore`.
//
// Two properties are load-bearing.
//
// ATOMICITY. Every write goes in ONE transaction. A summary that says
// "47 newly flagged" beside 12 rows would be the app misreporting its own
// conclusions, which is the failure this whole feature exists to prevent. The
// catch calls `invalidateChainHeadCache()` before anything else: insertEvent
// advances its cached chain head after each successful INSERT and only resets
// on an INSERT's own failure, so a rollback from any other throw would leave
// the cache pointing at a hash no longer in the table — and the next insert
// anywhere in the app would chain onto a row that does not exist.
//
// COST. `config:save` runs on the main thread while capture continues, so the
// scan is two phases: an indexed aggregation that never parses a row body, then
// hydration of only the targets whose verdict actually moved. The phases yield
// between them.

import { getDB } from './db/index'
import {
  insertEvent, invalidateChainHeadCache, _resetEventCountCache, type RedLogEvent
} from './db/events'
import { getSanitizedFields } from './sanitize'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'
import { scopeSignalFor, SCOPE_ELIGIBLE, SCOPE_KEY_SQL } from './alert/scope-signal'
import { classifyScopeTarget, buildScopeIndexes, isReportable } from './alert/policies'
import {
  planScopeRecompute, scopeHash, MAX_RETRO_ROWS,
  type CorpusEvent, type ExistingViolation, type ScopeSnapshot, type RecomputePlan
} from './scope-recompute'
import type { ScopeDistance } from './alert/policy'

const TABLES = ['events', 'events_logged'] as const
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Agent buckets that carry an eligible pair, with the subtypes to match. */
function buckets(): Array<{ agentType: string; subtypes: string[]; keySql: string }> {
  const byAgent = new Map<string, string[]>()
  for (const { agentType, subtype } of SCOPE_ELIGIBLE) {
    byAgent.set(agentType, [...(byAgent.get(agentType) ?? []), subtype])
  }
  return [...byAgent].map(([agentType, subtypes]) => ({
    agentType, subtypes, keySql: SCOPE_KEY_SQL[agentType]
  }))
}

export interface CandidateTarget {
  key: string
  count: number
  firstAt: number
  lastAt: number
}

/** Phase A — which targets exist in the corpus at all, without parsing a row.
 *  Grouped on the same expression the live path judged (never `target_id`,
 *  which is a different string). */
export function scanCandidates(): { candidates: Map<string, CandidateTarget>; scanned: { chained: number; logged: number } } {
  const db = getDB()
  const candidates = new Map<string, CandidateTarget>()
  const scanned = { chained: 0, logged: 0 }
  for (const table of TABLES) {
    for (const b of buckets()) {
      const holes = b.subtypes.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT ${b.keySql} AS k, COUNT(*) AS n, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
         FROM ${table}
         WHERE agent_type = ? AND json_extract(data, '$.subtype') IN (${holes})
           AND ${b.keySql} IS NOT NULL AND ${b.keySql} != ''
         GROUP BY k`
      ).all(b.agentType, ...b.subtypes) as Array<{ k: string; n: number; first_at: number; last_at: number }>
      for (const r of rows) {
        const prev = candidates.get(r.k)
        if (prev) {
          prev.count += r.n
          prev.firstAt = Math.min(prev.firstAt, r.first_at)
          prev.lastAt = Math.max(prev.lastAt, r.last_at)
        } else {
          candidates.set(r.k, { key: r.k, count: r.n, firstAt: r.first_at, lastAt: r.last_at })
        }
        if (table === 'events') scanned.chained += r.n
        else scanned.logged += r.n
      }
    }
  }
  return { candidates, scanned }
}

/** Every violation record and its standing. Read from the chained tier only —
 *  that is where all three subtypes live, by construction. */
export function readExistingViolations(): ExistingViolation[] {
  const db = getDB()
  const rows = db.prepare(
    `SELECT id, timestamp, data FROM events
     WHERE agent_type = 'system'
       AND json_extract(data, '$.subtype') IN ('scope_violation','scope_cleared')
     ORDER BY created_at ASC, rowid ASC`
  ).all() as Array<{ id: string; timestamp: number; data: string }>

  const violations: ExistingViolation[] = []
  const clearedIds = new Set<string>()
  const latestBySource = new Map<string, string>()

  for (const r of rows) {
    let d: Record<string, unknown>
    try { d = JSON.parse(r.data) } catch { continue }
    if (d.subtype === 'scope_cleared') {
      if (typeof d.violation_id === 'string') clearedIds.add(d.violation_id)
      continue
    }
    const causes = Array.isArray(d._causes) ? (d._causes as unknown[]) : []
    const sourceEventId = typeof causes[0] === 'string' ? (causes[0] as string) : null
    violations.push({
      id: r.id,
      target: String(d.target ?? ''),
      sourceEventId,
      timestamp: r.timestamp,
      distance: (d.distance as ScopeDistance) ?? 'unrelated',
      judged: d.judged === 'retroactive' ? 'retroactive' : 'live',
      cleared: false,
      supersededBy: null
    })
    // Rows arrive in insertion order, so the last writer for a source event
    // wins — the same "latest record about this event" rule the fold uses.
    if (sourceEventId) latestBySource.set(sourceEventId, r.id)
  }

  for (const v of violations) {
    v.cleared = clearedIds.has(v.id)
    if (v.sourceEventId) {
      const latest = latestBySource.get(v.sourceEventId)
      if (latest && latest !== v.id) v.supersededBy = latest
    }
  }
  return violations
}

/** Phase B — hydrate only the targets whose verdict moved, and rebuild each
 *  row's action the way the live path built it.
 *
 *  The sanitize overlay is not optional. Replacements are keyed by SOURCE event
 *  id and applied at export time, so a retroactive row that copied a redacted
 *  command verbatim would be a NEW row no overlay covers — and the bundle would
 *  ship the plaintext the operator asked to have removed. */
export function hydrateCorpus(targets: ReadonlySet<string>): CorpusEvent[] {
  if (targets.size === 0) return []
  const db = getDB()
  const out: CorpusEvent[] = []
  for (const table of TABLES) {
    for (const b of buckets()) {
      const holes = b.subtypes.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT id, timestamp, agent_type, data FROM ${table}
         WHERE agent_type = ? AND json_extract(data, '$.subtype') IN (${holes})
           AND ${b.keySql} IS NOT NULL
         ORDER BY timestamp DESC`
      ).all(b.agentType, ...b.subtypes) as Array<{ id: string; timestamp: number; agent_type: string; data: string }>
      for (const r of rows) {
        let data: Record<string, unknown>
        try { data = JSON.parse(r.data) } catch { continue }
        const replaced = getSanitizedFields(r.id)
        const sanitized = Object.keys(replaced).length > 0
        if (sanitized) Object.assign(data, replaced)
        const hit = scopeSignalFor(r.agent_type, data)
        if (!hit || !targets.has(hit.target)) continue
        out.push({
          id: r.id, timestamp: r.timestamp, target: hit.target,
          source: hit.source, action: hit.action.slice(0, 200),
          tier: table === 'events' ? 'chained' : 'logged',
          ...(sanitized ? { sanitized: true } : {})
        })
      }
    }
  }
  return out
}

export interface RecomputeResult {
  ran: boolean
  reason?: 'unconfigured' | 'unchanged'
  summaryId?: string
  plan?: RecomputePlan
}

export interface RunOptions {
  before: ScopeSnapshot
  after: ScopeSnapshot
  engagementId: string
  operatorId: string
  configChangedEventId?: string | null
  scopeFile?: { path: string; sha256: string | null; entries: number } | null
  /** Injected for tests; production passes nothing and gets Date.now. */
  now?: () => number
}

export async function runScopeRecompute(opts: RunOptions): Promise<RecomputeResult> {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const { before, after } = opts

  // An unconfigured scope classifies everything as in_scope, so running here
  // would withdraw every standing violation. The ordinary edit "remove the only
  // target, retype it" passes through that state twice, and each pass would
  // otherwise cost a thousand permanent signed rows.
  if (after.targets.length === 0) return { ran: false, reason: 'unconfigured' }

  const hashBefore = scopeHash(before)
  const hashAfter = scopeHash(after)

  const afterIdx = buildScopeIndexes(after.targets)
  const beforeIdx = buildScopeIndexes(before.targets)
  const distanceAfter = (t: string): ScopeDistance => classifyScopeTarget(t, after, afterIdx).distance
  const distanceBefore = (t: string): ScopeDistance => classifyScopeTarget(t, before, beforeIdx).distance

  const { candidates, scanned } = scanCandidates()
  await yieldToLoop()

  // Only targets whose verdict actually moved are worth hydrating. A boundary
  // change is what this feature reports on; re-judging a target nothing
  // happened to would cost the scan and produce nothing.
  const moved = new Set<string>()
  for (const key of candidates.keys()) {
    const d0 = distanceBefore(key)
    const d1 = distanceAfter(key)
    if (d0 !== d1 || isReportable(d0, before.alertFloor) !== isReportable(d1, after.alertFloor)) moved.add(key)
  }

  const existing = readExistingViolations()
  // A standing violation's target must be re-judged even when it is absent from
  // the corpus — that is how a withdrawal survives the logged tier being swept.
  for (const v of existing) if (!v.cleared || v.supersededBy === null) moved.add(v.target)

  const corpus = hydrateCorpus(moved)
  await yieldToLoop()

  const plan = planScopeRecompute({
    corpus, existing, after, classify: distanceAfter, cap: MAX_RETRO_ROWS
  })

  const nothingToSay = plan.flag.length === 0 && plan.regrade.length === 0 && plan.clear.length === 0
  if (nothingToSay && hashBefore === hashAfter) return { ran: false, reason: 'unchanged' }

  const written: RedLogEvent[] = []
  const ids = { engagementId: opts.engagementId, operatorId: opts.operatorId }

  try {
    getDB().transaction(() => {
      const summary = insertEvent('system', {
        subtype: 'scope_recomputed',
        scope_hash_before: hashBefore,
        scope_hash_after: hashAfter,
        targets_count_before: before.targets.length,
        targets_count_after: after.targets.length,
        excludes_count_before: before.excludeTargets.length,
        excludes_count_after: after.excludeTargets.length,
        ...(after.targets.length + after.excludeTargets.length <= 200
          ? { targets: after.targets, excludes: after.excludeTargets }
          : {
              targets_sample: [...after.targets].sort().slice(0, 20),
              excludes_sample: [...after.excludeTargets].sort().slice(0, 20)
            }),
        scope_file: opts.scopeFile ?? null,
        alert_floor: after.alertFloor,
        scanned: { ...scanned, targets: candidates.size, moved: moved.size },
        recomputed: plan.recomputed,
        newly_flagged: plan.counts.flagged,
        newly_flagged_written: plan.counts.flaggedWritten,
        newly_flagged_targets: [...new Set(plan.flag.map((r) => r.target))].slice(0, 10),
        regraded: plan.counts.regraded,
        regraded_written: plan.counts.regradedWritten,
        cleared: plan.counts.cleared,
        cleared_written: plan.counts.clearedWritten,
        cleared_targets: [...new Set(plan.clear.map((r) => r.target))].slice(0, 10),
        first_affected_at: plan.firstAffectedAt,
        last_affected_at: plan.lastAffectedAt,
        max_rows: MAX_RETRO_ROWS,
        duration_ms: now() - startedAt,
        description: `Scope recomputed: ${plan.recomputed} re-judged, +${plan.counts.flagged} newly flagged, −${plan.counts.cleared} cleared`,
        ...(opts.configChangedEventId ? { _causes: [opts.configChangedEventId] } : {})
      }, ids)
      if (!summary) throw new Error('scope_recomputed insert refused')
      written.push(summary)

      for (const row of [...plan.flag, ...plan.regrade]) {
        const verdict = classifyScopeTarget(row.target, after, afterIdx)
        const ev = insertEvent('system', {
          subtype: 'scope_violation',
          authority: verdict.authority,
          severity: verdict.severity,
          target: row.target,
          action: row.action,
          source: row.source,
          distance: row.distance,
          // Absence of these three is what makes every row already on disk read
          // as 當時就知道, with no migration.
          judged: 'retroactive',
          recompute_id: summary.id,
          source_ts: row.timestamp,
          source_tier: row.tier,
          ...(row.sanitized ? { source_sanitized: true } : {}),
          ...(row.regradeOf ? { regrade_of: row.regradeOf } : {}),
          ...(row.reflagOf ? { reflag_of: row.reflagOf } : {}),
          _causes: [row.sourceEventId ?? row.reflagOf ?? summary.id, summary.id]
        }, { ...ids, targetId: row.target })
        if (ev) written.push(ev)
      }

      for (const row of plan.clear) {
        const ev = insertEvent('system', {
          subtype: 'scope_cleared',
          target: row.target,
          distance_before: row.distanceBefore,
          distance_after: row.distanceAfter,
          judged_before: row.judgedBefore,
          violation_id: row.violationId,
          source_event_id: row.sourceEventId,
          source_ts: row.sourceTs,
          recompute_id: summary.id,
          description: `Scope cleared: ${row.target} (${row.distanceBefore} → ${row.distanceAfter})`,
          _causes: [row.violationId, summary.id]
        }, { ...ids, targetId: row.target })
        if (ev) written.push(ev)
      }
    })()
  } catch (e) {
    // Order matters: the chain-head cache must be forgotten before anything
    // else runs, or the next insert anywhere in the app chains onto a row the
    // rollback removed.
    invalidateChainHeadCache()
    _resetEventCountCache()
    noteDbError('scope-recompute', e)
    return { ran: false }
  }

  // Published after the commit, never inside it: a subscriber reacting to a row
  // that a later throw rolls back would show the operator a conclusion the
  // chain does not contain.
  for (const ev of written) eventBus.publish(ev, { bypassPause: true })
  return { ran: true, summaryId: written[0]?.id, plan }
}

/** The newest recompute summary, or null. Backs the Scope page banner, which
 *  needs no dismissal state because it is a projection of this row. */
export function queryLastScopeRecompute(): Record<string, unknown> | null {
  const row = getDB().prepare(
    `SELECT id, timestamp, data FROM events
     WHERE agent_type = 'system' AND json_extract(data, '$.subtype') = 'scope_recomputed'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get() as { id: string; timestamp: number; data: string } | undefined
  if (!row) return null
  try {
    return { id: row.id, timestamp: row.timestamp, ...(JSON.parse(row.data) as Record<string, unknown>) }
  } catch { return null }
}

export interface ScopeViolationRow {
  id: string
  target: string
  command: string
  timestamp: number
  sourceTs?: number
  distance: string
  judged: 'live' | 'retroactive'
  cleared: boolean
}

/** The Scope page's rows, read from the chain rather than from memory.
 *
 *  The page used to read an in-process log that held 500 rows and reset on
 *  every project switch, so it could not show a retroactive row at all and
 *  would keep counting one that had been withdrawn. */
export function queryScopeViolationRows(limit = 500): ScopeViolationRow[] {
  const existing = readExistingViolations()
  const db = getDB()
  const byId = new Map(existing.map((v) => [v.id, v]))
  const rows = db.prepare(
    `SELECT id, timestamp, data FROM events
     WHERE agent_type = 'system' AND json_extract(data, '$.subtype') = 'scope_violation'
     ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(limit) as Array<{ id: string; timestamp: number; data: string }>
  const out: ScopeViolationRow[] = []
  for (const r of rows) {
    let d: Record<string, unknown>
    try { d = JSON.parse(r.data) } catch { continue }
    const v = byId.get(r.id)
    if (v?.supersededBy) continue          // a newer record replaced it
    out.push({
      id: r.id,
      target: String(d.target ?? ''),
      command: String(d.action ?? ''),
      timestamp: r.timestamp,
      ...(typeof d.source_ts === 'number' ? { sourceTs: d.source_ts } : {}),
      distance: String(d.distance ?? ''),
      judged: d.judged === 'retroactive' ? 'retroactive' : 'live',
      cleared: v?.cleared ?? false
    })
  }
  return out
}

/** How many violations currently stand. Counted from the chain, not from a
 *  session-local log, so it survives a restart and reflects withdrawals. */
export function countActiveScopeViolations(): number {
  return readExistingViolations().filter((v) => !v.cleared && v.supersededBy === null).length
}
