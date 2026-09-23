// Which scope violations still stand. The recompute (main) and the Timeline
// (renderer) both answer this, so the rule lives here once: a `scope_cleared`
// naming a violation withdraws it, and of the violations about one source event
// only the one written last stands. `in_scope` verdicts share the subtype but
// are not violations, so they neither stand nor supersede.
//
// No imports: the renderer bundles this file.

export interface StandingRow {
  id: string
  createdAt: number
  data: Record<string, unknown>
}

export interface ViolationStanding {
  cleared: Set<string>
  /** Superseded violation id → the id of the violation written after it. */
  supersededBy: Map<string, string>
}

export function violationStanding(rows: readonly StandingRow[]): ViolationStanding {
  const cleared = new Set<string>()
  const sourceOf = new Map<string, string>()
  const latestBySource = new Map<string, string>()
  // "Written last" is insertion order, whatever order the caller holds its rows
  // in. The sort is stable, so rows sharing a createdAt keep the caller's order;
  // readExistingViolations passes them in rowid order.
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  for (const row of ordered) {
    const d = row.data
    if (d.subtype === 'scope_cleared') {
      if (typeof d.violation_id === 'string') cleared.add(d.violation_id)
      continue
    }
    if (d.subtype !== 'scope_violation' || d.distance === 'in_scope') continue
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
