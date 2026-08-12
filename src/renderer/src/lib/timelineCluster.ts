// The Timeline collapses events that fall within ~14px of each other on the same
// lane into a single clickable marker (with a count) so dense bursts stay
// legible. Zooming in widens the track, so clusters naturally split apart into
// individual dots. This is the pure core of that bucketing, extracted verbatim
// from Timeline.tsx's `clusters` memo so it can be pinned by tests before the
// timeline axis refactor (SPEC-TIMELINE-AXIS Step 1). Zero behaviour change is
// the whole point: same inputs must yield the same clusters as the inline code.
//
// Faithfulness notes on the mirrored semantics:
//   * Grid bucketing, NOT pairwise distance. Each item lands in bin
//     `Math.floor(x / mergePx)`; only *consecutive* items sharing a bin index
//     merge. Two items 2px apart still split if they straddle a bin boundary
//     (e.g. x=13 and x=15 → bins 0 and 1). This mirrors the inline code exactly.
//   * Input order is preserved and never re-sorted. The inline code relies on
//     `laneEvents[lane]` already being time-sorted; this function makes the same
//     assumption. Callers must supply each lane's items in the same (sorted)
//     order the Timeline already flattens them in.
//   * Lane grouping is stable by first appearance, matching the inline code's
//     per-lane `visibleLanes.forEach` walk where the caller flattens visible
//     lanes in row order and each lane's events are contiguous.

export interface ClusterInput {
  id: string
  /** the lane the event belongs to (source-type row today) */
  lane: string
  /** the event's pixel x on the track — i.e. the inline code's `toX(displayTs(e))` */
  x: number
}

export interface Cluster {
  /** stable key: `${lane}-${firstId}`, verbatim from the inline `out.push` */
  key: string
  lane: string
  /** representative x: the arithmetic mean of the member pixel xs */
  x: number
  /** member event ids, in input order */
  ids: string[]
  /** member count (== ids.length); drives the dot's count badge */
  count: number
}

// Default merge distance in pixels — the inline `CLUSTER_PX = 14`.
const CLUSTER_PX = 14

// Collapse same-lane, near-adjacent events into counted clusters.
//
// The returned li/y row geometry the inline memo also computes
// (`y = li * laneH + laneH / 2`) is intentionally NOT produced here: it is a
// rendering transform over the lane's row index, not part of the clustering, and
// the consumer recomputes it from the row position. Everything that is purely a
// function of the bucketing — key, lane, mean x, ids, count — lives here.
export function clusterEvents(items: ClusterInput[], mergePx: number = CLUSTER_PX): Cluster[] {
  // Group by lane, stable in first-seen order, preserving per-lane input order.
  // Mirrors the inline `visibleLanes.forEach` where each lane is visited once in
  // row order and its events are already contiguous and time-sorted.
  const byLane = new Map<string, ClusterInput[]>()
  for (const item of items) {
    const laneItems = byLane.get(item.lane)
    if (laneItems) laneItems.push(item)
    else byLane.set(item.lane, [item])
  }

  const out: Cluster[] = []
  for (const [lane, evs] of byLane) {
    if (!evs.length) continue
    let bucket: ClusterInput[] = []
    let curBi = NaN
    const flush = (): void => {
      if (!bucket.length) return
      const x = bucket.reduce((a, e) => a + e.x, 0) / bucket.length
      out.push({
        key: `${lane}-${bucket[0].id}`,
        lane,
        x,
        ids: bucket.map((e) => e.id),
        count: bucket.length
      })
      bucket = []
    }
    for (const e of evs) {
      const bi = Math.floor(e.x / mergePx)
      if (bucket.length && bi !== curBi) flush()
      curBi = bi
      bucket.push(e)
    }
    flush()
  }
  return out
}
