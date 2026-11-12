// Append-aware derivations for the Timeline (live ingest, 2026-11-11).
//
// Measured: with ~70 000 loaded events a live burst of 50 events/s cost the
// renderer 9 s of long tasks in 15 s, because every flush rebuilt ~25 derived
// structures over the whole array although only its tail had changed. Live rows
// almost always land after the newest loaded one, so the array a flush publishes
// is the previous one plus a tail. Each derivation here has a full `build` and
// an `extend` that folds just the tail into the previous result; `extend` may
// answer null when the tail changes something it cannot account for locally
// (a command_end that hides a start already drawn, a marker amendment, a row
// that sorts into the middle), and the caller then builds from scratch.
//
// The contract, and what test/timeline-incremental-equivalence.test.ts checks
// for every derivation over random in-order and out-of-order batches:
// `extend(build(prefix), all, prefix.length)` is either null or deep-equals
// `build(all)`. A result handed to React (an array, a set a memo depends on)
// is never mutated after it is returned; a derivation whose tail touches
// nothing returns the previous object itself. Internal tables and pure lookups
// may grow in place, which is said where they do.

import type { RedLogEvent } from '../../../core/db/event-types'
import { operationPairKey } from '../../../core/operation-pair-key'
import { isCollapsibleAgentTurn, collapseCommandPairs, filterAgentTurns, unfinishedCommandIds } from './timelineEvents'
import { buildToolPairIndex, type ToolPairIndex } from './toolPairing'
import { BAND_OF, displayTs, toLane, computeBadges, type EventBadge, type LaneId, type PluginEventType } from './timelineDomain'
import { buildFoldIndex, computeObservationStanding, buildEffectsIndex, buildBadgeIndex, type ObservationStanding } from './timelineAnnotations'
import { distributeLaneEvents, distributeRowEvents, singleTrackEvents, indexDrawnForMatches, type DrawnMatchIndex } from './timelineFilters'
import { countByLane } from '../components/timeline/TimelineLanesHeader'
import type { MarkerFold } from './markerFold'

type Events = readonly RedLogEvent[]

export interface Derivation<S, P extends readonly unknown[] = []> {
  build: (all: Events, ...params: P) => S
  extend: (prev: S, all: Events, from: number, ...params: P) => S | null
}

// ── Detecting an append ─────────────────────────────────────────────

const appendCache = new WeakMap<Events, { prev: Events; from: number }>()

/** `prev.length` when `next` is `prev` followed by zero or more rows (the very
 *  same row objects at the same positions), else -1. Pointer compares only, and
 *  remembered per pair, so the dozen derivations that ask about one flush pay
 *  for one walk. */
export function appendedFrom(prev: Events, next: Events): number {
  if (prev === next) return prev.length
  if (next.length < prev.length) return -1
  const hit = appendCache.get(next)
  if (hit && hit.prev === prev) return hit.from
  let from = prev.length
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i] !== next[i]) { from = -1; break }
  }
  appendCache.set(next, { prev, from })
  return from
}

export interface DerivationCache<S, P extends readonly unknown[]> {
  input: Events
  params: P
  state: S
}

const sameParams = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

/** One step of a derivation: extend the cached result when `all` appends to
 *  the cached input under the same parameters, otherwise build. */
export function stepDerivation<S, P extends readonly unknown[]>(
  d: Derivation<S, P>,
  cache: DerivationCache<S, P> | null,
  all: Events,
  ...params: P
): DerivationCache<S, P> {
  if (cache && sameParams(cache.params, params)) {
    if (cache.input === all) return cache
    const from = appendedFrom(cache.input, all)
    if (from >= 0) {
      const next = from === all.length ? cache.state : d.extend(cache.state, all, from, ...params)
      if (next !== null) return { input: all, params, state: next }
    }
  }
  return { input: all, params, state: d.build(all, ...params) }
}

// ── What is drawn: command pairs folded, agent turns optionally hidden ──

interface Closed { data: Record<string, unknown>; conflict: boolean }
export interface DrawnState {
  out: RedLogEvent[]
  closed: Map<string, Closed>
  /** Pair keys of every command_start seen, drawn or not. */
  startKeys: Set<string>
}

const isShell = (e: RedLogEvent, subtype: string): boolean => e.agentType === 'shell' && e.data?.subtype === subtype

function startVisible(e: RedLogEvent, closed: ReadonlyMap<string, Closed>): boolean {
  const key = operationPairKey(e)
  const end = key ? closed.get(key) : undefined
  return !end || end.conflict || typeof e.data.command !== 'string' || end.data.command !== e.data.command
}

/** `filterAgentTurns(collapseCommandPairs(all), collapse)`. */
export const drawnEvents: Derivation<DrawnState, [collapseAgentTurns: boolean]> = {
  build(all, collapse) {
    // The pair table `extend` continues from, alongside the original fold.
    const closed = new Map<string, Closed>()
    const startKeys = new Set<string>()
    for (const e of all) {
      if (isShell(e, 'command_start')) { const k = operationPairKey(e); if (k) startKeys.add(k) }
      if (!isShell(e, 'command_end')) continue
      const key = operationPairKey(e)
      if (!key) continue
      const previous = closed.get(key)
      if (!previous) closed.set(key, { data: e.data, conflict: false })
      else if (JSON.stringify(previous.data) !== JSON.stringify(e.data)) previous.conflict = true
    }
    return { out: filterAgentTurns(collapseCommandPairs(all as RedLogEvent[]), collapse), closed, startKeys }
  },
  extend(prev, all, from, collapse) {
    // Check first, mutate after: a refusal must leave `prev` untouched.
    const tailEnds = new Set<string>()
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      if (!isShell(e, 'command_end')) continue
      const key = operationPairKey(e)
      if (!key) continue
      // A second end for a key can turn on `conflict`, and an end for a start
      // already seen can hide it: both change rows before the tail.
      if (prev.closed.has(key) || prev.startKeys.has(key) || tailEnds.has(key)) return null
      tailEnds.add(key)
    }
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      if (isShell(e, 'command_end')) { const k = operationPairKey(e); if (k) prev.closed.set(k, { data: e.data, conflict: false }) }
      if (isShell(e, 'command_start')) { const k = operationPairKey(e); if (k) prev.startKeys.add(k) }
    }
    const added: RedLogEvent[] = []
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      if (isShell(e, 'command_start') && !startVisible(e, prev.closed)) continue
      if (collapse && isCollapsibleAgentTurn(e)) continue
      added.push(e)
    }
    return { out: added.length ? prev.out.concat(added) : prev.out, closed: prev.closed, startKeys: prev.startKeys }
  }
}

// ── Starts with no end anywhere in what is loaded ───────────────────

export interface UnfinishedState {
  out: Set<string>
  ended: Set<string>
  startsByKey: Map<string, string[]>
}

/** `unfinishedCommandIds(all)`. */
export const unfinishedCommands: Derivation<UnfinishedState> = {
  build(all) {
    const ended = new Set<string>()
    const startsByKey = new Map<string, string[]>()
    for (const e of all) {
      const key = isShell(e, 'command_end') || isShell(e, 'command_start') ? operationPairKey(e) : null
      if (!key) continue
      if (isShell(e, 'command_end')) { ended.add(key); continue }
      const list = startsByKey.get(key)
      if (list) list.push(e.id); else startsByKey.set(key, [e.id])
    }
    return { out: unfinishedCommandIds(all as RedLogEvent[]), ended, startsByKey }
  },
  extend(prev, all, from) {
    let out = prev.out
    const writable = (): Set<string> => (out === prev.out ? (out = new Set(prev.out)) : out)
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      if (!isShell(e, 'command_end')) continue
      const key = operationPairKey(e)
      if (!key || prev.ended.has(key)) continue
      prev.ended.add(key)
      for (const id of prev.startsByKey.get(key) ?? []) if (out.has(id)) writable().delete(id)
    }
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      if (!isShell(e, 'command_start')) continue
      const key = operationPairKey(e)
      if (!key) continue
      const list = prev.startsByKey.get(key)
      if (list) list.push(e.id); else prev.startsByKey.set(key, [e.id])
      if (!prev.ended.has(key)) writable().add(e.id)
    }
    return out === prev.out ? prev : { out, ended: prev.ended, startsByKey: prev.startsByKey }
  }
}

// ── tool_call ↔ tool_result ─────────────────────────────────────────

/** `buildToolPairIndex(all)`. */
export const toolPairs: Derivation<ToolPairIndex<RedLogEvent>> = {
  build: (all) => buildToolPairIndex(all),
  extend(prev, all, from) {
    let next: ToolPairIndex<RedLogEvent> | null = null
    for (let i = from; i < all.length; i++) {
      const event = all[i]
      if (event.agentType !== 'agent' || !event.data) continue
      const key = operationPairKey(event)
      const subtype = event.data.subtype
      if (!key || (subtype !== 'tool_call' && subtype !== 'tool_result')) continue
      next ??= { calls: new Map(prev.calls), results: new Map(prev.results), conflicts: new Set(prev.conflicts) }
      const map = subtype === 'tool_call' ? next.calls : next.results
      const previous = map.get(key)
      if (!previous) map.set(key, event)
      else if (JSON.stringify(previous.data) !== JSON.stringify(event.data)) next.conflicts.add(key)
    }
    return next ?? prev
  }
}

// ── Lanes: which are populated, how many rows each, the rows themselves ──

export interface LaneIndex {
  populated: Set<LaneId>
  counts: ReadonlyMap<LaneId, number>
  lanes: Record<LaneId, RedLogEvent[]>
}

const laneOf = (e: RedLogEvent, pluginTypes: PluginEventType[]): LaneId =>
  toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)

/** The populated-lane set, `countByLane` and `distributeLaneEvents`, in one walk. */
export const laneIndex: Derivation<LaneIndex, [pluginTypes: PluginEventType[]]> = {
  build(all, pluginTypes) {
    // First-seen order, as the Set the panel used to build in its own walk.
    const counts = countByLane(all, pluginTypes)
    return { populated: new Set(counts.keys()), counts, lanes: distributeLaneEvents(all, pluginTypes) }
  },
  extend(prev, all, from, pluginTypes) {
    const counts = new Map(prev.counts)
    const added = new Map<LaneId, RedLogEvent[]>()
    let populated = prev.populated
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      const lane = laneOf(e, pluginTypes)
      if (!populated.has(lane)) { if (populated === prev.populated) populated = new Set(prev.populated); populated.add(lane) }
      counts.set(lane, (counts.get(lane) ?? 0) + 1)
      const list = added.get(lane)
      if (list) list.push(e); else added.set(lane, [e])
    }
    const lanes = { ...prev.lanes }
    for (const [lane, rows] of added) lanes[lane] = prev.lanes[lane].concat(rows)
    return { populated, counts, lanes }
  }
}

// ── The standard track: every row, by display time ──────────────────

/** `singleTrackEvents(all, displayTs)`: a stable sort, so a tail whose display
 *  times are all at or after the last one simply follows it. */
export const singleTrack: Derivation<RedLogEvent[]> = {
  build: (all) => singleTrackEvents(all, displayTs),
  extend(prev, all, from) {
    const last = prev.length ? displayTs(prev[prev.length - 1]) : -Infinity
    const tail = all.slice(from)
    for (const e of tail) if (displayTs(e) < last) return null
    return prev.concat(tail.sort((a, b) => displayTs(a) - displayTs(b)))
  }
}

/** `distributeRowEvents` for the swim lanes. */
export const swimRows: Derivation<Record<string, RedLogEvent[]>, [
  visibleRows: readonly string[], collapsedBands: ReadonlySet<string>, pluginTypes: PluginEventType[], hiddenLanes: ReadonlySet<LaneId>
]> = {
  build: (all, visibleRows, collapsedBands, pluginTypes, hiddenLanes) =>
    distributeRowEvents(all, visibleRows, collapsedBands, pluginTypes, hiddenLanes),
  extend(prev, all, from, _visibleRows, collapsedBands, pluginTypes, hiddenLanes) {
    const added = new Map<string, RedLogEvent[]>()
    for (let i = from; i < all.length; i++) {
      const key = rowKey(all[i], collapsedBands, pluginTypes, hiddenLanes)
      if (key === null || !prev[key]) continue
      const list = added.get(key)
      if (list) list.push(all[i]); else added.set(key, [all[i]])
    }
    if (added.size === 0) return prev
    const map = { ...prev }
    for (const [key, rows] of added) map[key] = prev[key].concat(rows)
    return map
  }
}

function rowKey(e: RedLogEvent, collapsedBands: ReadonlySet<string>, pluginTypes: PluginEventType[], hiddenLanes: ReadonlySet<LaneId>): string | null {
  const lane = laneOf(e, pluginTypes)
  if (hiddenLanes.has(lane)) return null
  return collapsedBands.has(BAND_OF[lane]) ? BAND_OF[lane] : lane
}

// ── The zoom ceiling's input: the tightest gap ─────────────────────

export interface GapState { last: number; min: number }

/** The smallest positive gap between consecutive display times of an ordered
 *  track (the standard track). `Infinity` with none. */
export const trackGap: Derivation<GapState> = {
  build(all) {
    let last = NaN
    let min = Infinity
    for (const e of all) {
      const ts = displayTs(e)
      const d = ts - last
      if (d > 0 && d < min) min = d
      last = ts
    }
    return { last, min }
  },
  extend(prev, all, from) {
    let { last, min } = prev
    for (let i = from; i < all.length; i++) {
      const ts = displayTs(all[i])
      const d = ts - last
      if (d > 0 && d < min) min = d
      last = ts
    }
    return min === prev.min && last === prev.last ? prev : { last, min }
  }
}

export interface LaneGapState { last: Map<LaneId, number>; min: number }

/** The same per lane, each lane in loaded order (the swim lanes). */
export const laneGap: Derivation<LaneGapState, [pluginTypes: PluginEventType[]]> = {
  build(all, pluginTypes) {
    return laneGap.extend({ last: new Map(), min: Infinity }, all, 0, pluginTypes) as LaneGapState
  },
  extend(prev, all, from, pluginTypes) {
    const last = new Map(prev.last)
    let min = prev.min
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      const lane = laneOf(e, pluginTypes)
      const ts = displayTs(e)
      const before = last.get(lane)
      if (before !== undefined) { const d = ts - before; if (d > 0 && d < min) min = d }
      last.set(lane, ts)
    }
    return { last, min }
  }
}

// ── Extremes ────────────────────────────────────────────────────────

export interface Extent { lo: number; hi: number; n: number }

/** Min and max `timestamp`. */
export const timestampExtent: Derivation<Extent> = {
  build: (all) => timestampExtent.extend({ lo: Infinity, hi: -Infinity, n: 0 }, all, 0) as Extent,
  extend(prev, all, from) {
    let { lo, hi } = prev
    for (let i = from; i < all.length; i++) { const t = all[i].timestamp; if (t < lo) lo = t; if (t > hi) hi = t }
    return { lo, hi, n: prev.n + all.length - from }
  }
}

/** Max display time; `-Infinity` with no rows. */
export const latestDisplay: Derivation<number> = {
  build: (all) => latestDisplay.extend(-Infinity, all, 0) as number,
  extend(prev, all, from) {
    let max = prev
    for (let i = from; i < all.length; i++) { const d = displayTs(all[i]); if (d > max) max = d }
    return max
  }
}

/** `displayTs` of every row, in loaded order. */
export const displayStamps: Derivation<number[]> = {
  build: (all) => all.map(displayTs),
  extend: (prev, all, from) => prev.concat(all.slice(from).map(displayTs))
}

/** Rows the agent-turn collapse hides. */
export const collapsibleTurnCount: Derivation<number> = {
  build: (all) => collapsibleTurnCount.extend(0, all, 0) as number,
  extend(prev, all, from) {
    let n = prev
    for (let i = from; i < all.length; i++) if (isCollapsibleAgentTurn(all[i])) n++
    return n
  }
}

// ── Annotations ─────────────────────────────────────────────────────

/** `buildEffectsIndex(all)`. */
export const effectsIndex: Derivation<Map<string, string[]>> = {
  build: (all) => buildEffectsIndex(all),
  extend(prev, all, from) {
    let m: Map<string, string[]> | null = null
    // Lists still shared with `prev`; each is copied before its first push.
    const shared = new Set<string>()
    for (let i = from; i < all.length; i++) {
      const e = all[i]
      const causes = (e.data as { _causes?: unknown } | undefined)?._causes
      if (!Array.isArray(causes)) continue
      for (const c of causes) {
        if (typeof c !== 'string') continue
        if (!m) { m = new Map(prev); for (const k of prev.keys()) shared.add(k) }
        const arr = m.get(c)
        if (!arr) m.set(c, [e.id])
        else if (shared.has(c)) { shared.delete(c); m.set(c, [...arr, e.id]) }
        else arr.push(e.id)
      }
    }
    return m ?? prev
  }
}

const hasAgent = (all: Events, from: number, agentType: string): boolean => {
  for (let i = from; i < all.length; i++) if (all[i].agentType === agentType) return true
  return false
}

/** `buildFoldIndex(all)`: only marker rows take part, so a tail without one
 *  changes nothing. */
export const foldIndex: Derivation<Map<string, MarkerFold>> = {
  build: (all) => buildFoldIndex(all),
  extend: (prev, all, from) => (hasAgent(all, from, 'marker') ? null : prev)
}

/** `computeObservationStanding(all)`: only system rows take part. */
export const observationStanding: Derivation<ObservationStanding> = {
  build: (all) => computeObservationStanding(all),
  extend: (prev, all, from) => (hasAgent(all, from, 'system') ? null : prev)
}

/** `buildBadgeIndex(all, brokenAtId, cleared, superseded)`. */
export const badgeIndex: Derivation<Map<string, EventBadge[]>, [
  brokenAtId: string | null, cleared: ReadonlySet<string>, superseded: ReadonlySet<string>
]> = {
  build: (all, brokenAtId, cleared, superseded) => buildBadgeIndex(all, brokenAtId, cleared, superseded),
  extend(prev, all, from, brokenAtId, cleared, superseded) {
    let m: Map<string, EventBadge[]> | null = null
    for (let i = from; i < all.length; i++) {
      const b = computeBadges(all[i], brokenAtId, cleared, superseded)
      if (!b.length) continue
      m ??= new Map(prev)
      m.set(all[i].id, b)
    }
    return m ?? prev
  }
}

// ── Lookups the `/` box's dimming reads ──────────────────────────────
//
// These two grow in place: they are lookup tables read during the render that
// asked for them, never handed to a memo or a child as a dependency, so a new
// wrapper object per step is enough and copying 70 000 entries is not.

/** The drawn rows' ids, command ends and first agent row per session. */
export const drawnMatchIndex: Derivation<{ index: DrawnMatchIndex }> = {
  build: (all) => ({ index: indexDrawnForMatches(all) }),
  extend: (prev, all, from) => ({ index: indexDrawnForMatches(all, from, prev.index) })
}

/** Loaded rows by id. */
export const rowsById: Derivation<{ byId: Map<string, RedLogEvent> }> = {
  build: (all) => rowsById.extend({ byId: new Map() }, all, 0) as { byId: Map<string, RedLogEvent> },
  extend(prev, all, from) {
    for (let i = from; i < all.length; i++) prev.byId.set(all[i].id, all[i])
    return { byId: prev.byId }
  }
}

/** The rows the session bands are drawn from: terminal ends and recording
 *  pauses. `buildSessionBands` looks at nothing else, in loaded order. */
export const sessionBoundaries: Derivation<RedLogEvent[]> = {
  build: (all) => all.filter(isBoundary),
  extend(prev, all, from) {
    const added = all.slice(from).filter(isBoundary)
    return added.length ? prev.concat(added) : prev
  }
}

function isBoundary(e: RedLogEvent): boolean {
  if (e.agentType === 'shell') return e.data?.subtype === 'session_end'
  if (e.agentType !== 'system') return false
  const sub = e.data?.subtype
  return sub === 'recording_paused' || sub === 'recording_resumed'
}
