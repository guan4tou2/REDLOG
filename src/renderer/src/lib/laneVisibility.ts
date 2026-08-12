// Extracted verbatim (Phase C step 1) from Timeline.tsx's inline `populatedLanes`
// / `visibleLanes` memos + the solo derivation in the T3 modes memo, so the lane
// visibility rules have test coverage BEFORE the axis refactor changes the lane
// model. Zero behaviour change is the point.
//
// The mirrored inline code:
//   populatedLanes = new Set(events.map(e => toLane(e.agentType, e.data?.subtype, pluginTypes)))
//   visibleLanes   = LANES.filter(l => populatedLanes.has(l) && !hiddenLanes.has(l))
//   isSolo         = visibleLanes.length === 1 && hiddenLanes.size > 0
//
// Kept pure by taking `laneOf` and the ordered lane list as parameters rather
// than importing Timeline's LANES/toLane — the seam must not depend on the
// component it will be wired back into.

export type LaneId = string

/**
 * The set of lanes that have at least one event. Order-free (a Set), exactly
 * like the inline memo; `visibleLanes` reimposes the canonical order.
 */
export function populatedLanes<E>(events: readonly E[], laneOf: (e: E) => LaneId): Set<LaneId> {
  const seen = new Set<LaneId>()
  for (const e of events) seen.add(laneOf(e))
  return seen
}

/**
 * The lanes that get a row: populated AND not hidden, in the canonical `allLanes`
 * order (not event/insertion order). Mirrors `LANES.filter(...)`.
 */
export function visibleLanes(
  allLanes: readonly LaneId[],
  populated: ReadonlySet<LaneId>,
  hidden: ReadonlySet<LaneId>
): LaneId[] {
  return allLanes.filter((l) => populated.has(l) && !hidden.has(l))
}

/**
 * The soloed lane, or null. "Solo" is not stored directly — it is the derived
 * state of exactly one lane surviving while others are explicitly hidden. Returns
 * the lane id; the caller maps it to a label (the inline code does
 * `laneLabels[visibleLanes[0]]`). Mirrors `isSolo` exactly:
 *   visible.length === 1 && hidden.size > 0
 */
export function soloLaneOf(visible: readonly LaneId[], hidden: ReadonlySet<LaneId>): LaneId | null {
  return visible.length === 1 && hidden.size > 0 ? visible[0] : null
}
