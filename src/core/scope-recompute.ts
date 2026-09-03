// What changes when the allowlist changes (docs/DESIGN-core-and-capture.md §1,
// design turn 8a).
//
// An operator adds a host to the exclude list on day four. Everything they did
// to it on day two was out of scope all along — they just did not know it yet.
// The log should be able to say so, and today it cannot: scope is judged once,
// at insert time, and never revisited.
//
// The obvious implementation is the forbidden one. Nothing here updates or
// deletes a row: a re-judgement writes NEW violation records, a withdrawal
// writes a record citing the one it withdraws, and both carry enough to tell
// 當時就知道 from 事後才判定 without asking anything but the data. The `events`
// table would refuse an UPDATE anyway — that refusal is the design, not an
// obstacle.
//
// This module is the decision and nothing else: no database, no clock, no
// config. It is handed what the corpus contains and what verdicts already
// exist, and it returns the rows to append. Shaped after body-eviction.ts for
// the same reason — a policy that deletes or reclassifies evidence should be
// readable in one screen and testable without a project.
//
// MATCHER NOTE. Callers must classify with the POLICY matcher
// (`classifyScopeTarget`), never with `matchTarget` from db/events: the latter
// is a case-insensitive substring test, so the pattern `evil` matches
// `a.evil.example`. Parity with the verdict the live path produced is the whole
// point of a recompute, and the two matchers answer different questions.

import crypto from 'crypto'
import type { ScopeDistance } from './alert/policy'
import type { ScopeSignalSource } from './alert/scope-signal'

/** Written rows are capped per kind so one careless allowlist edit cannot add
 *  thousands of permanent signed rows. The summary reports the true count
 *  beside the written one, so truncation is visible rather than silent. */
export const MAX_RETRO_ROWS = 500

/** Live violations whose signal carried no source event id (the producer had
 *  none) still cover the events they were about. Without a window, every event
 *  behind such a row would be re-flagged as newly discovered. */
const CAUSELESS_COVERAGE_MS = 2000

export interface ScopeSnapshot {
  targets: string[]
  excludeTargets: string[]
  alertFloor: ScopeDistance[]
}

/** One stored event the live path was eligible to judge, already hydrated and
 *  with its judged target derived exactly as the live path derived it. */
export interface CorpusEvent {
  id: string
  timestamp: number
  target: string
  source: ScopeSignalSource
  action: string
  tier: 'chained' | 'logged'
  /** True when a redaction replacement was overlaid onto `action`. */
  sanitized?: boolean
}

/** A violation record already in the chain, live or retroactive. */
export interface ExistingViolation {
  id: string
  target: string
  /** `_causes[0]`, or null for a live row whose producer had no event id. */
  sourceEventId: string | null
  timestamp: number
  distance: ScopeDistance
  judged: 'live' | 'retroactive'
  /** A `scope_cleared` row cites it. */
  cleared: boolean
  /** A newer violation row cites the same source event. */
  supersededBy: string | null
}

export interface RetroRow {
  sourceEventId: string | null
  target: string
  action: string
  source: ScopeSignalSource
  distance: ScopeDistance
  timestamp: number
  tier: 'chained' | 'logged'
  sanitized?: boolean
  /** Set when this row supersedes an existing violation at a different
   *  distance rather than reporting something previously unflagged. */
  regradeOf?: string
  /** Set when the source event is gone from the corpus and the row is rebuilt
   *  from the record that was cleared. */
  reflagOf?: string
}

export interface ClearRow {
  violationId: string
  target: string
  sourceEventId: string | null
  sourceTs: number
  distanceBefore: ScopeDistance
  distanceAfter: ScopeDistance
  judgedBefore: 'live' | 'retroactive'
}

export interface RecomputePlan {
  /** Eligible source events actually re-judged. */
  recomputed: number
  targetsRecomputed: number
  flag: RetroRow[]
  regrade: RetroRow[]
  clear: ClearRow[]
  counts: {
    flagged: number
    flaggedWritten: number
    regraded: number
    regradedWritten: number
    cleared: number
    clearedWritten: number
  }
  firstAffectedAt: number | null
  lastAffectedAt: number | null
}

export interface PlanInput {
  corpus: readonly CorpusEvent[]
  existing: readonly ExistingViolation[]
  after: ScopeSnapshot
  /** Verdict for one target under the scope now in force. Injected so this
   *  module needs no policy import and the caller cannot accidentally classify
   *  with a different matcher than it uses elsewhere. */
  classify: (target: string) => ScopeDistance
  cap?: number
}

/**
 * The scope in force, as a stable fingerprint.
 *
 * Sorted so that reordering the list is not a change, and the alert FLOOR is
 * deliberately excluded: turning `warnOnViolation` off narrows what is
 * reported, but it does not move the boundary — hashing it would make a
 * notification preference re-judge the entire corpus.
 */
export function scopeHash(scope: Pick<ScopeSnapshot, 'targets' | 'excludeTargets'>): string {
  const canonical = JSON.stringify({
    targets: [...scope.targets].sort(),
    excludeTargets: [...scope.excludeTargets].sort()
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

const reportable = (d: ScopeDistance, floor: readonly ScopeDistance[]): boolean =>
  d !== 'in_scope' && floor.includes(d)

/**
 * Decide what to append.
 *
 * The model is coverage by SOURCE EVENT, not by time span. A violation record
 * is ACTIVE when nothing has withdrawn it and no newer record has replaced it;
 * an active record is what makes an event "already known to be out of scope",
 * and its absence is what makes one newly flagged.
 */
export function planScopeRecompute(input: PlanInput): RecomputePlan {
  const cap = input.cap ?? MAX_RETRO_ROWS
  const floor = input.after.alertFloor

  const active = input.existing.filter((v) => !v.cleared && v.supersededBy === null)
  const activeBySource = new Map<string, ExistingViolation>()
  const causeless: ExistingViolation[] = []
  for (const v of active) {
    if (v.sourceEventId) activeBySource.set(v.sourceEventId, v)
    else causeless.push(v)
  }

  // A live row written without a source event id still covered the events it
  // was about. Anything eligible with the same target in the couple of seconds
  // before it is treated as already known, or the first recompute would report
  // it as a fresh discovery.
  const coveredByCauseless = (e: CorpusEvent): boolean =>
    causeless.some((v) =>
      v.target === e.target && e.timestamp <= v.timestamp && v.timestamp - e.timestamp <= CAUSELESS_COVERAGE_MS
    )

  const verdicts = new Map<string, ScopeDistance>()
  const distanceOf = (target: string): ScopeDistance => {
    const known = verdicts.get(target)
    if (known) return known
    const d = input.classify(target)
    verdicts.set(target, d)
    return d
  }

  const flag: RetroRow[] = []
  const regrade: RetroRow[] = []
  const touchedTargets = new Set<string>()

  for (const e of input.corpus) {
    touchedTargets.add(e.target)
    const distance = distanceOf(e.target)
    const existing = activeBySource.get(e.id)

    if (!reportable(distance, floor)) continue   // clearing is handled below, over records

    if (!existing) {
      if (coveredByCauseless(e)) continue
      flag.push({
        sourceEventId: e.id, target: e.target, action: e.action, source: e.source,
        distance, timestamp: e.timestamp, tier: e.tier, sanitized: e.sanitized
      })
      continue
    }
    // Already flagged, but the rung changed. `adjacent_domain → excluded` is
    // the case that matters: an inferred warning becoming an explicit deny. The
    // chain's latest verdict would otherwise still read "warning" while the
    // scope in force says the operator forbade it — knowable only by rerunning
    // the classifier by hand, which is exactly what §1 rules out.
    if (existing.distance !== distance) {
      regrade.push({
        sourceEventId: e.id, target: e.target, action: e.action, source: e.source,
        distance, timestamp: e.timestamp, tier: e.tier, sanitized: e.sanitized,
        regradeOf: existing.id
      })
    }
  }

  // Withdrawals are computed over RECORDS, never by rescanning the corpus: the
  // logged tier is pruned after thirty days, so a violation's source row may be
  // long gone while the violation itself — chained — is still standing. A
  // rescan would quietly leave those active forever.
  const clear: ClearRow[] = []
  const reflag: RetroRow[] = []
  for (const v of active) {
    const distance = distanceOf(v.target)
    touchedTargets.add(v.target)
    if (reportable(distance, floor)) continue
    clear.push({
      violationId: v.id, target: v.target, sourceEventId: v.sourceEventId,
      sourceTs: v.timestamp, distanceBefore: v.distance, distanceAfter: distance,
      judgedBefore: v.judged
    })
  }

  // The mirror case: a violation was withdrawn earlier, the target has become
  // reportable again, and its source event is no longer in the corpus (pruned,
  // or an agent-tool violation that never had one). Without this the active
  // count reads zero for a target the operator has explicitly forbidden again.
  const corpusIds = new Set(input.corpus.map((e) => e.id))
  const flaggedSources = new Set(flag.map((r) => r.sourceEventId))
  for (const v of input.existing) {
    if (!v.cleared || v.supersededBy !== null) continue
    const distance = distanceOf(v.target)
    if (!reportable(distance, floor)) continue
    if (v.sourceEventId && (corpusIds.has(v.sourceEventId) || flaggedSources.has(v.sourceEventId))) continue
    if (activeBySource.has(v.sourceEventId ?? '')) continue
    touchedTargets.add(v.target)
    reflag.push({
      sourceEventId: v.sourceEventId, target: v.target, action: '', source: 'shell',
      distance, timestamp: v.timestamp, tier: 'chained', reflagOf: v.id
    })
  }

  // Freshest first, so a cap keeps what the operator is most likely to be
  // looking at rather than the oldest rows in the project.
  const byNewest = (a: { timestamp: number }, b: { timestamp: number }): number => b.timestamp - a.timestamp
  const allFlags = [...flag, ...reflag].sort(byNewest)
  regrade.sort(byNewest)
  clear.sort((a, b) => b.sourceTs - a.sourceTs)

  const flagWritten = allFlags.slice(0, cap)
  const regradeWritten = regrade.slice(0, cap)
  const clearWritten = clear.slice(0, cap)

  const stamps = [
    ...flagWritten.map((r) => r.timestamp),
    ...regradeWritten.map((r) => r.timestamp),
    ...clearWritten.map((r) => r.sourceTs)
  ]

  return {
    recomputed: input.corpus.length,
    targetsRecomputed: touchedTargets.size,
    flag: flagWritten,
    regrade: regradeWritten,
    clear: clearWritten,
    counts: {
      flagged: allFlags.length,
      flaggedWritten: flagWritten.length,
      regraded: regrade.length,
      regradedWritten: regradeWritten.length,
      cleared: clear.length,
      clearedWritten: clearWritten.length
    },
    firstAffectedAt: stamps.length ? Math.min(...stamps) : null,
    lastAffectedAt: stamps.length ? Math.max(...stamps) : null
  }
}
