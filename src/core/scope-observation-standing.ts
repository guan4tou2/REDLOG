import { SCOPE_VIOLATION_SUBTYPE } from './scope-vocabulary'
// Which scope violations still stand. The recompute (main) and the Timeline
// (renderer) both answer this, so the rule lives here once: a `scope_cleared`
// naming a violation withdraws it, and of the violations about one source event
// only the one written last stands. `in_scope` verdicts share the subtype but
// are not violations, so they neither stand nor supersede.
//
// Imports only scope-vocabulary, itself import-free: the renderer bundles this file.

export interface StandingRow {
  id: string
  createdAt: number
  data: Record<string, unknown>
}

export interface ObservationStanding {
  cleared: Set<string>
  /** Superseded violation id → the id of the violation written after it. */
  supersededBy: Map<string, string>
}

/** Whether a scope row's payload is a violation record at all. `in_scope`
 *  verdicts share the subtype and are written once per in-scope request as the
 *  adherence counter's positive proof, but they never stand, never supersede and
 *  never change a count — so everything that reads violations, and everything
 *  that decides when a cached answer about them is stale, asks this one question. */
export function countsAsStandingVerdict(d: Record<string, unknown>): boolean {
  return d.subtype === SCOPE_VIOLATION_SUBTYPE && d.distance !== 'in_scope'
}

export function observationStanding(rows: readonly StandingRow[]): ObservationStanding {
  const cleared = new Set<string>()
  const sourceOf = new Map<string, string>()
  const latestBySource = new Map<string, string>()
  // "Written last" is insertion order, whatever order the caller holds its rows
  // in. The sort is stable, so rows sharing a createdAt keep the caller's order;
  // readExistingObservations passes them in rowid order.
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  for (const row of ordered) {
    const d = row.data
    if (d.subtype === 'scope_cleared') {
      if (typeof d.violation_id === 'string') cleared.add(d.violation_id)
      continue
    }
    if (!countsAsStandingVerdict(d)) continue
    const causes = Array.isArray(d._causes) ? (d._causes as unknown[]) : []
    const source = typeof causes[0] === 'string' ? causes[0] : null
    if (!source) continue
    sourceOf.set(row.id, source)
    latestBySource.set(source, row.id)
  }
  const supersededBy = new Map<string, string>()
  for (const [id, source] of sourceOf) {
    const latest = latestBySource.get(source)
    if (latest && latest !== id) supersededBy.set(id, latest)
  }
  return { cleared, supersededBy }
}
