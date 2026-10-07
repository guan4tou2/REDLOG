// Is the record still sound, asked without being asked.
//
// Capture health is polled every thirty seconds and raises an issue when the
// pipeline degrades. The chain was not: drift, a failed anchor and a broken
// sample row were computed in exactly two places, both of which the operator
// has to walk to — the dashboard's stat tile, and the Verify button in
// Settings ▸ Integrity. So a twelve-hour engagement could run with a drifted
// chain, a dead anchor loop or a broken sample and show nothing at all,
// unless somebody happened to visit ⌘1 or ⌘9.
//
// That is the wrong shape for this class of fault. A capture outage costs the
// events it drops; a chain fault costs the defensibility of everything already
// written, and it is silent by nature — the record keeps growing and every
// screen keeps looking normal. The longer it goes unnoticed the more of the
// engagement is inside the doubt.
//
// Pure, so the same reading can drive the status bar and the dashboard and
// the two cannot disagree.

export type IntegrityFaultKind = 'chain-drift' | 'sample-broken' | 'anchor-failed' | 'anchor-stale'

export interface IntegrityReading {
  /** Rows carrying a hash. */
  chainLen: number
  /** Rows in the chained tier. Equal to `chainLen` on a sound chain. */
  eventCount: number
  lastAnchor: { createdAt: number; status: string } | null
  /** From capture health, which already carries it and was ignoring it. */
  sampleBroken: boolean
  now?: number
}

export interface IntegrityFault {
  kind: IntegrityFaultKind
  /** Fills the {{...}} in the fault's own string. */
  vars: Record<string, string | number>
}

/** Beyond this, the anchor loop is not slow, it is broken. OpenTimestamps
 *  aggregates on a calendar cadence measured in hours; a day without one means
 *  submissions have been failing or nothing has been trying. */
export const ANCHOR_DEAD_HOURS = 24

/**
 * The single worst thing wrong with the record, or null.
 *
 * One fault, not a list. The status bar is one line and an operator who is
 * mid-engagement acts on one thing; the ranking below is what to act on first.
 *
 *   chain-drift    hashes and rows disagree — the record cannot be walked
 *   sample-broken  a row failed its own verification
 *   anchor-failed  the last submission errored
 *   anchor-stale   no anchor for a day
 *
 * A missing anchor is NOT a fault. A project can be minutes old, or the
 * operator can have turned anchoring off; alarming about the absence of
 * something nobody asked for is how a status bar teaches people to ignore it.
 * Nor is a two-hour-old anchor: the dashboard tints that amber, and an alarm
 * that fires on a normal hiccup is worse than no alarm.
 */
export function integrityFault(r: IntegrityReading): IntegrityFault | null {
  if (r.chainLen !== r.eventCount) {
    return { kind: 'chain-drift', vars: { chain: r.chainLen, events: r.eventCount } }
  }
  if (r.sampleBroken) return { kind: 'sample-broken', vars: {} }
  if (!r.lastAnchor) return null
  if (r.lastAnchor.status === 'failed') return { kind: 'anchor-failed', vars: {} }
  const hours = Math.floor(((r.now ?? Date.now()) - r.lastAnchor.createdAt) / 3_600_000)
  if (hours >= ANCHOR_DEAD_HOURS) {
    return { kind: 'anchor-stale', vars: { days: Math.max(1, Math.floor(hours / 24)) } }
  }
  return null
}
