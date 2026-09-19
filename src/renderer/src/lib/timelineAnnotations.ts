import type { RedLogEvent } from '../../../core/db/event-types'

/**
 * Reverse-effects index: for each cause event id, the list of event ids
 * that name it in their `_causes` array. O(N × avg-causes).
 */
export function buildEffectsIndex(events: readonly RedLogEvent[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const e of events) {
    const causes = (e.data as { _causes?: unknown } | undefined)?._causes
    if (!Array.isArray(causes)) continue
    for (const c of causes) {
      if (typeof c !== 'string') continue
      const arr = m.get(c)
      if (arr) arr.push(e.id)
      else m.set(c, [e.id])
    }
  }
  return m
}

export interface ViolationStanding {
  cleared: Set<string>
  superseded: Set<string>
}

/**
 * Which scope violations no longer stand — either explicitly cleared
 * (`scope_cleared` naming a `violation_id`) or superseded by a newer
 * violation citing the same source event. `events` must be newest-first.
 */
export function computeViolationStanding(events: readonly RedLogEvent[]): ViolationStanding {
  const cleared = new Set<string>()
  const superseded = new Set<string>()
  const latestBySource = new Map<string, string>()
  for (const e of events) {
    if (e.agentType !== 'system') continue
    const d = (e.data ?? {}) as Record<string, unknown>
    if (d.subtype === 'scope_cleared') {
      if (typeof d.violation_id === 'string') cleared.add(d.violation_id)
      continue
    }
    if (d.subtype !== 'scope_violation') continue
    const causes = Array.isArray(d._causes) ? (d._causes as unknown[]) : []
    const src = typeof causes[0] === 'string' ? (causes[0] as string) : null
    if (!src) continue
    if (latestBySource.has(src)) superseded.add(e.id)
    else latestBySource.set(src, e.id)
  }
  return { cleared, superseded }
}

