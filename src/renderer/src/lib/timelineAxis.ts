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
export function laneOfEvent<E extends AxisEvent>(
  axis: LaneAxis,
  event: E,
  sourceLaneOf: (e: E) => string
): string {
  if (axis === 'source') return sourceLaneOf(event)
  const t = event.targetId
  return t == null || t === '' ? UNTARGETED_LANE : t
}

export interface LaneModel<E extends AxisEvent> {
  /** ordered lane descriptors for the axis */
  lanes: AxisLane[]
  /** which lane a given event belongs to (agrees with `lanes`) */
  laneOf: (e: E) => string
  /** events grouped by lane id; every lane in `lanes` has an entry (possibly []),
   *  mirroring the inline `Object.fromEntries(LANES.map(...))` seeding so callers
   *  can index `laneEvents[lane]` for any lane without an undefined check */
  laneEvents: Record<string, E[]>
}

/**
 * The complete lane model for an axis in one pass: the ordered lanes, the
 * event→lane mapping, and events grouped by lane (seeded so every lane has an
 * array). `source` reproduces the inline behaviour exactly (lanes = sourceLanes,
 * grouped by sourceLaneOf); `target` groups by target with the untargeted lane
 * last. Pure — the renderer supplies sourceLanes / sourceLaneOf.
 */
export function buildLaneModel<E extends AxisEvent>(
  axis: LaneAxis,
  events: readonly E[],
  sourceLanes: readonly AxisLane[],
  sourceLaneOf: (e: E) => string,
  untargetedLabel: string
): LaneModel<E> {
  const lanes = lanesForAxis(axis, events, sourceLanes, untargetedLabel)
  const laneOf = (e: E): string => laneOfEvent(axis, e, sourceLaneOf)
  const laneEvents: Record<string, E[]> = {}
  for (const l of lanes) laneEvents[l.id] = []
  for (const e of events) {
    const id = laneOf(e)
    // target ids are data-derived, so a lane not pre-seeded can appear; guard.
    ;(laneEvents[id] ??= []).push(e)
  }
  return { lanes, laneOf, laneEvents }
}
