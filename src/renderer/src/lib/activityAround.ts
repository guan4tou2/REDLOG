import type { ActivitySummary } from '../../../core/activity-contract'
import type { EventQueryOptions, RedLogEvent } from '../../../core/db/events'
import { sourceSessionKey } from '../../../core/operation-pair-key'
import { windowAround } from './timeRangeInput'

/** Minutes either side of the anchor, and how many events are listed per side. */
export const AROUND_MINUTES = 5
export const AROUND_PER_SIDE = 5

/** The only keys that say two events belong together. Time never does. */
export type AroundRelation = 'command' | 'flow' | 'tool' | 'session'

const idOf = (event: RedLogEvent, key: string): string | null => {
  const value = event.data?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * How `other` is tied to `anchor`, or null when nothing but the clock is.
 *
 * A command ID and a tool-use ID are unique only inside one source Session, so
 * they count only together with it; a flow ID names one HTTP flow on its own.
 * The strongest key wins. Null is a fact, not a gap: the two events merely
 * happened close together, and the screen must not say more than that.
 */
export function aroundRelation(anchor: RedLogEvent, other: RedLogEvent): AroundRelation | null {
  const scope = sourceSessionKey(anchor)
  const sameSession = scope !== null && scope === sourceSessionKey(other)
  const same = (key: string): boolean => {
    const id = idOf(anchor, key)
    return id !== null && id === idOf(other, key)
  }
  if (sameSession && same('command_id')) return 'command'
  if (same('flow_id')) return 'flow'
  if (sameSession && same('tool_use_id')) return 'tool'
  return sameSession ? 'session' : null
}

export interface AroundWindow {
  before: RedLogEvent[]
  after: RedLogEvent[]
  /** The window holds more on that side than is listed. */
  moreBefore: boolean
  moreAfter: boolean
}

/**
 * The queries for one operation: the events just before and just after its
 * anchor, from the same window the Timeline's "around" opens (`windowAround`).
 * Each side asks for the nearest ones, and for room to drop the operation's own
 * events, which are not "around" it.
 */
export function aroundQueries(item: ActivitySummary, extra: Pick<EventQueryOptions, 'inScopeOnly' | 'hidePersonal'> = {}): { before: EventQueryOptions; after: EventQueryOptions } {
  const at = item.anchor.timestamp
  const range = windowAround(at, AROUND_MINUTES)
  const limit = AROUND_PER_SIDE + 1 + item.sourcePreview.ids.length + 1
  const common = { limit, excludeHousekeeping: true, ...extra }
  return {
    before: { ...common, since: range.since, before: at, order: 'newest' },
    after: { ...common, since: at, before: range.before, order: 'oldest' }
  }
}

/** Trims what the two queries returned to the nearest few per side, each side in
 *  clock order and without the operation's own events. */
export function shapeAround(item: ActivitySummary, before: RedLogEvent[], after: RedLogEvent[]): AroundWindow {
  const own = new Set([item.anchor.id, ...item.sourcePreview.ids])
  const nearestBefore = before.filter(event => !own.has(event.id))
  const nearestAfter = after.filter(event => !own.has(event.id))
  return {
    before: nearestBefore.slice(0, AROUND_PER_SIDE).reverse(),
    after: nearestAfter.slice(0, AROUND_PER_SIDE),
    moreBefore: nearestBefore.length > AROUND_PER_SIDE,
    moreAfter: nearestAfter.length > AROUND_PER_SIDE
  }
}

/** `+4.2 s`, `−1 m 12 s`: the distance from the anchor, signed, for reading a list. */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '−' : '+'
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)} s`
  const seconds = Math.round(abs / 1000)
  return `${sign}${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, '0')} s`
}
