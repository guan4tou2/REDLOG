// Where the Timeline's selection goes next (docs/UIUX-STANDARD.md §6).
//
// Kept pure and out of Timeline.tsx because the interesting part is the
// question each axis answers, and that is worth stating once and testing
// directly rather than inferring from a 4,000-line component:
//
//   ← →    stay in the lane. A lane is one producer, so walking it reads that
//          producer's story in order.
//   ↑ ↓    change lane and land on whatever was nearest in time. That is what
//          "what else was happening at this moment" means, and it is why this
//          cannot be a flat list walk — the flat list interleaves lanes, so
//          ↓ landed somewhere unrelated and an operator learned not to use it.
//   ⇧← ⇧→  skip to the next event that carries state. The dense middle of a
//          scan is a hundred rows that say nothing happened.

import type { RedLogEvent } from '../../../core/db/events'

export type SelectionMove =
  | 'nav-prev' | 'nav-next'
  | 'nav-lane-up' | 'nav-lane-down'
  | 'nav-state-prev' | 'nav-state-next'
  | 'nav-first' | 'nav-last'

export interface SelectionContext<L extends string = string> {
  events: RedLogEvent[]
  hiddenLanes: ReadonlySet<L>
  pluginTypes: ReadonlySet<string> | Map<string, unknown> | undefined
  laneOrder: readonly L[]
  /** Lane of an event. Injected so this module needs no lane taxonomy. */
  laneOf: (e: RedLogEvent) => L
  /** Timestamp used for placement — markers can render off their own clock. */
  tsOf: (e: RedLogEvent) => number
}

/**
 * An event "carries state" when it says something changed rather than that
 * work happened: a command that failed, a scope violation, credentials found.
 * Deliberately generous — a shift-arrow that skips too little is a nuisance,
 * one that skips past the thing you were looking for is a bug.
 */
export function carriesState(e: RedLogEvent): boolean {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (typeof d.exitCode === 'number' && d.exitCode !== 0) return true
  if (d.severity === 'critical' || d.severity === 'important') return true
  if (d.violation === true || d.inScope === false) return true
  return ['loot', 'scope', 'marker', 'credential_use', 'c2_checkin'].includes(e.agentType)
}

export function nextSelection<L extends string>(
  move: SelectionMove,
  current: RedLogEvent | null,
  ctx: SelectionContext<L>
): RedLogEvent | null {
  const visible = ctx.events
    .filter((e) => !ctx.hiddenLanes.has(ctx.laneOf(e)))
    .sort((a, b) => ctx.tsOf(a) - ctx.tsOf(b))
  if (visible.length === 0) return null

  if (move === 'nav-first') return visible[0]
  if (move === 'nav-last') return visible[visible.length - 1]

  // Nothing selected: any movement key starts at the beginning rather than
  // doing nothing, so the keyboard is reachable without touching the mouse.
  if (!current) return visible[0]

  const at = ctx.tsOf(current)
  const lane = ctx.laneOf(current)

  if (move === 'nav-prev' || move === 'nav-next') {
    const sameLane = visible.filter((e) => ctx.laneOf(e) === lane)
    const i = sameLane.findIndex((e) => e.id === current.id)
    if (i < 0) return null
    return sameLane[i + (move === 'nav-prev' ? -1 : 1)] ?? null
  }

  if (move === 'nav-state-prev' || move === 'nav-state-next') {
    const forward = move === 'nav-state-next'
    const pool = visible.filter((e) => carriesState(e) && e.id !== current.id)
    const after = pool.filter((e) => (forward ? ctx.tsOf(e) > at : ctx.tsOf(e) < at))
    return forward ? after[0] ?? null : after[after.length - 1] ?? null
  }

  // Lane change: walk the lane order from the current lane, skipping hidden
  // and empty lanes, and land on whichever event in the next occupied lane is
  // nearest in time.
  const occupied = ctx.laneOrder.filter(
    (l) => !ctx.hiddenLanes.has(l) && visible.some((e) => ctx.laneOf(e) === l)
  )
  const li = occupied.indexOf(lane)
  if (li < 0) return null
  const target = occupied[li + (move === 'nav-lane-up' ? -1 : 1)]
  if (!target) return null
  const inTarget = visible.filter((e) => ctx.laneOf(e) === target)
  return inTarget.reduce((best, e) =>
    Math.abs(ctx.tsOf(e) - at) < Math.abs(ctx.tsOf(best) - at) ? e : best, inTarget[0]) ?? null
}
