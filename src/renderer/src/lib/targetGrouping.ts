// The target axis for the reconstruction timeline (DESIGN-PRINCIPLES §8/§9): review
// asks "what happened to *this target*", so the timeline organises by target instead
// of by source-type lane. This pure seam is that axis's data source — it turns a flat
// event list into per-target groups, ordered the way the axis draws them.
//
// §12: EXPLICIT untargeted bucket — never orphan, never guess. Attribution here is
// conservative: an event only joins a target group when it carries a concrete targetId.
// Anything ambiguous — targetId null, undefined, or '' — is NOT guessed onto a nearby
// target; it drops into one explicit `target: null` "untargeted" bucket. That bucket
// is a real, addressable group (so nothing is orphaned) and always sorts LAST, so it
// reads as the residual pile rather than as just another target.

export interface EventLike {
  id: string
  timestamp: number
  targetId?: string | null
}

export interface TargetGroup {
  /** The concrete targetId, or null for the explicit untargeted bucket (§12). */
  target: string | null
  /** Member event ids, ascending by timestamp. */
  eventIds: string[]
  /** Timestamp of the group's earliest event. */
  firstTs: number
  /** Timestamp of the group's latest event. */
  lastTs: number
}

const UNTARGETED = null

// null/undefined/'' all mean "no concrete target" → the untargeted bucket. Anything
// else is taken as an authoritative target id.
function targetKeyOf(event: EventLike): string | null {
  const t = event.targetId
  if (t === null || t === undefined || t === '') return UNTARGETED
  return t
}

/**
 * Group events by targetId. Events without a concrete target collapse into a single
 * explicit `target: null` bucket. Targeted groups are ordered by their earliest event
 * timestamp (ascending); the untargeted bucket, if present, always comes last. Within
 * every group eventIds are sorted ascending by timestamp, and firstTs/lastTs bound the
 * group's time range. Empty input yields [].
 */
export function groupByTarget(events: EventLike[]): TargetGroup[] {
  // Bucket events by target while preserving nothing but membership; sorting happens
  // once at the end so unsorted input still produces correct group and member order.
  const buckets = new Map<string | null, EventLike[]>()
  for (const event of events) {
    const key = targetKeyOf(event)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(event)
    else buckets.set(key, [event])
  }

  const groups: TargetGroup[] = []
  for (const [target, members] of buckets) {
    const sorted = [...members].sort((a, b) => a.timestamp - b.timestamp)
    groups.push({
      target,
      eventIds: sorted.map((e) => e.id),
      firstTs: sorted[0].timestamp,
      lastTs: sorted[sorted.length - 1].timestamp
    })
  }

  // Group order: untargeted bucket always last (§12); targeted groups by firstTs asc.
  groups.sort((a, b) => {
    if (a.target === UNTARGETED) return 1
    if (b.target === UNTARGETED) return -1
    return a.firstTs - b.firstTs
  })

  return groups
}
