import { groupByTarget } from './targetGrouping'

// Phase C step 2 (SPEC-TIMELINE-AXIS): the timeline's swim-lane rows can come
// from either the current source-type lanes OR a target grouping. This seam is
// the single place that decision lives, so the renderer maps events → rows the
// same way regardless of axis.
//
// The 'source' axis is a deliberate pass-through: it returns the lanes the
// caller already computes (populated, canonical order) and defers lane-of to the
// caller's existing toLane. That is what makes shipping 'source' as the default a
// byte-for-byte no-op — nothing changes until an operator opts into 'target'.
//
// The 'target' axis wraps the Phase B groupByTarget (untargeted bucket always
// last, §12: never orphan, never guess). laneOfEvent MUST agree with
// lanesForAxis on ids, so every event lands in exactly one rendered lane.

export type LaneAxis = 'source' | 'target'

export interface AxisLane {
  id: string
  label: string
}

// Minimal event shape both axes need. Target axis reads id/timestamp/targetId
// (via groupByTarget); source axis reads whatever the caller's sourceLaneOf
// needs (e.g. agentType/subtype) — hence the open index signature.
export interface AxisEvent {
  id: string
  timestamp: number
  targetId?: string | null
  [k: string]: unknown
}

/** Stable id for the catch-all lane holding events with no target (§12). */
export const UNTARGETED_LANE = '__untargeted__'

/**
 * The ordered lane descriptors for an axis.
 *   source → the caller's lanes, unchanged (the zero-change default).
 *   target → one lane per target from groupByTarget, untargeted last, labelled
 *            with the target id (or `untargetedLabel` for the null bucket).
 */
export function lanesForAxis(
  axis: LaneAxis,
  events: readonly AxisEvent[],
  sourceLanes: readonly AxisLane[],
  untargetedLabel: string
): AxisLane[] {
  if (axis === 'source') return [...sourceLanes]
  return groupByTarget(events).map((g) => ({
    id: g.target ?? UNTARGETED_LANE,
    label: g.target ?? untargetedLabel
  }))
}

/**
 * Which lane a single event belongs to under an axis. Agrees with lanesForAxis:
 *   source → the caller's sourceLaneOf (existing toLane).
 *   target → the event's target id, or UNTARGETED_LANE for null/undefined/''.
 */
export function laneOfEvent(
  axis: LaneAxis,
  event: AxisEvent,
  sourceLaneOf: (e: AxisEvent) => string
): string {
  if (axis === 'source') return sourceLaneOf(event)
  const t = event.targetId
  return t == null || t === '' ? UNTARGETED_LANE : t
}
