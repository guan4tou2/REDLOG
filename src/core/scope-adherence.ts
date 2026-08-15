// Scope-adherence report — the POSITIVE proof (`ALERT-ROLES.md` D.3, G-D1).
//
// RedLog does not prevent (Part D). Its deliverable is therefore "provably did
// not exceed scope", not "was unable to" — and until now nothing produced that
// proof. `data:exportViolations` shows the violations, which is the ACCUSATION
// half; a client reading it has no way to tell 3 near-misses out of 250 targets
// from 3 out of 5. This builds the other half: every target touched, how each
// one classifies, and the denominator.
//
// It is a pure function of (events, scope) so it can be tested without a DB and
// so the same code answers for a live session, an export, and a bundle.

import { classifyDistance, type ScopeDistance, type ViolationReason } from './scope-monitor'
import type { ScopeProvenance } from './config'

interface EventLike {
  timestamp: number
  agentType: string
  targetId?: string | null
  data?: Record<string, unknown> | null
}

export interface ScopeConfigSnapshot {
  targets: string[]
  excludeTargets: string[]
  proximityBits?: number
  publicSuffixes?: string[]
  alertFloor?: string
  /** G-D2: where the scope came from. A report that says "judged against this
   *  scope" is only as good as the reviewer's ability to check that scope — the
   *  digest is what lets them recompute it against the authorisation document
   *  they were given. Null when the operator typed the targets in directly. */
  provenance?: ScopeProvenance | null
}

export interface TargetRow {
  target: string
  distance: ScopeDistance
  firstSeen: number
  lastSeen: number
  /** How many operator actions hit this target. */
  count: number
  /** A sample of the commands, capped — the full record is the timeline. */
  commands: string[]
}

export interface RecordedViolation {
  target: string
  reason: ViolationReason
  authority: 'fact' | 'inferred'
  timestamp: number
}

export interface ScopeAdherenceReport {
  generatedAt: number
  engagementId: string | null
  scope: ScopeConfigSnapshot
  /** Counts by distance, plus the denominator. `targets` is DISTINCT hosts. */
  totals: Record<ScopeDistance, number> & { targets: number; actions: number }
  targets: TargetRow[]
  /** Violations exactly as they were recorded at the time, from the chain. */
  recordedViolations: RecordedViolation[]
  /** Scope edits inside the window. Re-classification below uses the CURRENT
   *  scope, so a non-empty list here means the counts describe the engagement
   *  as judged by today's scope — not necessarily the one in force at the time.
   *  Surfacing it is the difference between a caveat and a silent error. */
  scopeChanges: Array<{ timestamp: number; changed: Record<string, unknown> }>
  /** Targets whose live classification differs from what was recorded. Empty is
   *  the expected case; a non-empty list is the honest consequence of a scope
   *  edit mid-engagement, not a bug. */
  disagreements: Array<{ target: string; recorded: ViolationReason; current: ScopeDistance }>
}

const MAX_COMMAND_SAMPLES = 5
const COMMAND_SLICE = 200

/** What the operator aimed an action at. `system` events are RedLog's own
 *  bookkeeping — a `scope_violation` carries the offending host in `targetId`,
 *  and counting it would inflate the very target it is reporting on. */
function targetOf(e: EventLike): string | null {
  if (e.agentType === 'system') return null
  const detected = e.data?.detectedTarget
  if (typeof detected === 'string' && detected) return detected
  return e.targetId || null
}

function distanceMatchesReason(distance: ScopeDistance, reason: ViolationReason): boolean {
  if (reason === 'excluded_target') return distance === 'excluded'
  return distance === reason
}

export function buildAdherenceReport(
  events: readonly EventLike[],
  scope: ScopeConfigSnapshot,
  opts: { generatedAt: number; engagementId?: string | null }
): ScopeAdherenceReport {
  const rows = new Map<string, TargetRow>()
  const recordedViolations: RecordedViolation[] = []
  const scopeChanges: ScopeAdherenceReport['scopeChanges'] = []
  let actions = 0

  for (const e of events) {
    const sub = e.data?.subtype as string | undefined

    if (e.agentType === 'system' && sub === 'scope_violation') {
      recordedViolations.push({
        target: String(e.data?.target ?? e.targetId ?? ''),
        reason: (e.data?.reason as ViolationReason) ?? 'unrelated',
        authority: (e.data?.authority as 'fact' | 'inferred') ?? 'fact',
        timestamp: e.timestamp
      })
      continue
    }

    if (e.agentType === 'system' && sub === 'config_changed') {
      const changed = (e.data?.changed as Record<string, unknown>) ?? {}
      const scopeKeys = Object.keys(changed).filter((k) => k.startsWith('scope.'))
      if (scopeKeys.length > 0) {
        scopeChanges.push({
          timestamp: e.timestamp,
          changed: Object.fromEntries(scopeKeys.map((k) => [k, changed[k]]))
        })
      }
      continue
    }

    const target = targetOf(e)
    if (!target) continue
    actions += 1

    const existing = rows.get(target)
    const command = typeof e.data?.command === 'string' ? e.data.command.slice(0, COMMAND_SLICE) : null
    if (existing) {
      existing.count += 1
      existing.firstSeen = Math.min(existing.firstSeen, e.timestamp)
      existing.lastSeen = Math.max(existing.lastSeen, e.timestamp)
      if (command && existing.commands.length < MAX_COMMAND_SAMPLES && !existing.commands.includes(command)) {
        existing.commands.push(command)
      }
    } else {
      rows.set(target, {
        target,
        distance: classifyDistance(target, scope),
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
        count: 1,
        commands: command ? [command] : []
      })
    }
  }

  const totals: ScopeAdherenceReport['totals'] = {
    in_scope: 0, excluded: 0, adjacent_subnet: 0, adjacent_domain: 0, unrelated: 0,
    targets: rows.size, actions
  }
  for (const row of rows.values()) totals[row.distance] += 1

  // Worst first, then by how much traffic each took — a client reading this
  // wants the problems at the top, not an alphabetical list.
  const ORDER: Record<ScopeDistance, number> = {
    excluded: 0, adjacent_subnet: 1, adjacent_domain: 2, unrelated: 3, in_scope: 4
  }
  const targets = [...rows.values()].sort(
    (a, b) => ORDER[a.distance] - ORDER[b.distance] || b.count - a.count || a.target.localeCompare(b.target)
  )

  const seenDisagreement = new Set<string>()
  const disagreements: ScopeAdherenceReport['disagreements'] = []
  for (const v of recordedViolations) {
    const row = rows.get(v.target)
    if (!row || seenDisagreement.has(v.target)) continue
    if (distanceMatchesReason(row.distance, v.reason)) continue
    seenDisagreement.add(v.target)
    disagreements.push({ target: v.target, recorded: v.reason, current: row.distance })
  }

  return {
    generatedAt: opts.generatedAt,
    engagementId: opts.engagementId ?? null,
    scope,
    totals,
    targets,
    recordedViolations,
    scopeChanges,
    disagreements
  }
}

/** One line a human reads first — the shape of the claim the report supports.
 *  "247 targets, 244 in scope, 0 excluded, 3 adjacent" is the sentence a client
 *  deliverable needs; the arrays below it are the evidence for it. */
export function summariseAdherence(r: ScopeAdherenceReport): string {
  const t = r.totals
  const adjacent = t.adjacent_subnet + t.adjacent_domain
  const parts = [
    `${t.targets} target${t.targets === 1 ? '' : 's'}`,
    `${t.in_scope} in scope`,
    `${t.excluded} excluded`,
    `${adjacent} adjacent`
  ]
  if (t.unrelated > 0) parts.push(`${t.unrelated} off-list`)
  return parts.join(', ')
}
