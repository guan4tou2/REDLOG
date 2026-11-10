import { describe, it, expect } from 'vitest'
import { computeWindowSlice, type ViewportWindow } from '../src/renderer/src/lib/timelineFilters'
import { displayTs, toLane, type LaneId } from '../src/renderer/src/lib/timelineDomain'
import type { RedLogEvent } from '../src/core/db/event-types'

// computeWindowSlice replaced a newest-first walk of the whole array with a
// bisection. The walk below is that old implementation, kept verbatim as the
// reference: the new one must return the same rows in the same order and the
// same totals for every window, including markers drawn at their own
// `atTimestamp` and the early exit at the newest visible row shown at its own
// time before the window.

type Visible = (e: RedLogEvent) => boolean

function referenceScan(
  events: readonly RedLogEvent[],
  isVisible: Visible,
  vp: ViewportWindow,
  cap: number,
  collect: boolean
): { items: RedLogEvent[]; total: number } {
  const widthPx = (vp.width / 100) * vp.trackW
  const wholeTrackVisible = widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99)
  const items: RedLogEvent[] = []
  let total = 0
  const take = (e: RedLogEvent): void => {
    total++
    if (collect && items.length < cap) items.push(e)
  }

  if (wholeTrackVisible || vp.timeSpan <= 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (isVisible(events[i])) take(events[i])
    }
    return { items, total }
  }

  const from = vp.fromX((vp.left / 100) * vp.trackW)
  const to = vp.fromX(((vp.left + vp.width) / 100) * vp.trackW)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!isVisible(e)) continue
    const d = vp.displayTs(e)
    if (d > to) continue
    if (d < from) { if (d === e.timestamp) break; continue }
    take(e)
  }
  if (total > 0) return { items, total }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (isVisible(e) && vp.displayTs(e) <= to) take(e)
  }
  return { items, total }
}

function referenceSlice(
  events: readonly RedLogEvent[],
  hidden: ReadonlySet<LaneId>,
  vp: ViewportWindow,
  cap: number,
  matched: ReadonlySet<string> | null
): { recent: RedLogEvent[]; totalAll: number; total: number } {
  const lane: Visible = (e) => !hidden.has(toLane(e.agentType, e.data?.subtype as string | undefined, undefined))
  const withMatch: Visible = (e) => lane(e) && (matched === null || matched.has(e.id))
  return {
    recent: referenceScan(events, withMatch, vp, cap, true).items.reverse(),
    totalAll: referenceScan(events, lane, vp, 0, false).total,
    total: referenceScan(events, withMatch, vp, 0, false).total
  }
}

// mulberry32: small, seeded, so a failure names the seed that reproduces it.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KINDS = ['shell', 'shell', 'shell', 'scanner', 'dns', 'agent', 'marker', 'marker'] as const

function makeEvents(rand: () => number, n: number, span: number): RedLogEvent[] {
  const events: RedLogEvent[] = []
  for (let i = 0; i < n; i++) {
    const agentType = KINDS[Math.floor(rand() * KINDS.length)]
    // Small spans force equal timestamps, which a bisection must not mishandle.
    const timestamp = 1000 + Math.floor(rand() * span)
    const data: Record<string, unknown> = {}
    if (agentType === 'marker' && rand() < 0.8) {
      // Backdated, forward-dated, or at its own time.
      data.atTimestamp = rand() < 0.1 ? timestamp : 1000 + Math.floor(rand() * (span + span / 4))
    }
    events.push({
      id: `e${i}`, timestamp, engagementId: 'eng', sessionId: 's', operatorId: 'op', agentType,
      hostname: 'h', sourceIP: null, targetId: null, data, hash: 'h', prevHash: null,
      createdAt: timestamp
    } as unknown as RedLogEvent)
  }
  // The array the Timeline holds: ordered by timestamp, ties in arrival order.
  return events.sort((a, b) => a.timestamp - b.timestamp)
}

function makeVp(rand: () => number, t0: number, span: number): ViewportWindow {
  const trackW = 2000
  const kind = rand()
  let left: number
  let width: number
  if (kind < 0.08) { left = 0; width = 100 }                       // whole track
  else if (kind < 0.12) { left = rand() * 90; width = 0 }          // not measured
  else { width = 0.2 + rand() * 60; left = rand() * (100 - width) }
  if (rand() < 0.4) {
    // Edges that land exactly on whole timestamps, where a boundary that is
    // off by one (>= against >) changes the answer.
    const w = 1 + Math.floor(rand() * 60)
    return {
      left: Math.floor(rand() * (100 - w)), width: w, trackW: 100,
      fromX: (px) => t0 + Math.round((px * span) / 100),
      displayTs, timeSpan: span
    }
  }
  return {
    left, width, trackW,
    fromX: (px) => t0 + (px / trackW) * span,
    displayTs,
    timeSpan: rand() < 0.03 ? 0 : span
  }
}

describe('computeWindowSlice equals the newest-first walk it replaced', () => {
  it('over randomised sorted arrays, windows, lane filters and query matches', () => {
    let windowed = 0
    let fallback = 0
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed)
      const span = [20, 400, 5000][seed % 3]
      const events = makeEvents(rand, Math.floor(rand() * 120), span)
      const hidden = new Set<LaneId>()
      for (const k of ['dns', 'agent', 'scanner'] as const) {
        if (rand() < 0.25) hidden.add(toLane(k, undefined, undefined))
      }
      const matched = rand() < 0.5 ? null : new Set(events.filter(() => rand() < 0.4).map((e) => e.id))
      const cap = [1, 5, 50][Math.floor(rand() * 3)]
      for (let w = 0; w < 12; w++) {
        const vp = makeVp(rand, 1000, span)
        const want = referenceSlice(events, hidden, vp, cap, matched)
        const got = computeWindowSlice(events, hidden, undefined, vp, cap, matched)
        const where = `seed ${seed}, window ${w} (left ${vp.left.toFixed(2)}, width ${vp.width.toFixed(2)})`
        expect(got.recent.map((e) => e.id), where).toEqual(want.recent.map((e) => e.id))
        expect(got.totalAll, where).toBe(want.totalAll)
        expect(got.total, where).toBe(want.total)
        if (want.totalAll === 0) fallback++
        else windowed++
      }
    }
    // The run must have exercised both answers, or it proves less than it says.
    expect(windowed).toBeGreaterThan(500)
    expect(fallback).toBeGreaterThan(100)
  })

  it('with no query, total is totalAll and recent is the same rows as before', () => {
    const rand = rng(7)
    const events = makeEvents(rand, 80, 400)
    const vp = makeVp(rand, 1000, 400)
    const got = computeWindowSlice(events, new Set<LaneId>(), undefined, vp, 50, null)
    expect(got.total).toBe(got.totalAll)
  })

  it('a marker stored after the window but drawn inside it is counted', () => {
    const base = { engagementId: 'e', sessionId: 's', operatorId: 'o', hostname: 'h', sourceIP: null, targetId: null, hash: 'h', prevHash: null }
    const events = [
      { ...base, id: 'a', agentType: 'shell', timestamp: 500, createdAt: 500, data: {} },
      { ...base, id: 'b', agentType: 'shell', timestamp: 900, createdAt: 900, data: {} },
      { ...base, id: 'm', agentType: 'marker', timestamp: 950, createdAt: 950, data: { atTimestamp: 520 } }
    ] as unknown as RedLogEvent[]
    const vp: ViewportWindow = { left: 40, width: 30, trackW: 1000, fromX: (px) => px, displayTs, timeSpan: 1000 }
    // window 400..700: a (500) and the marker drawn at 520, though stored at 950
    const got = computeWindowSlice(events, new Set<LaneId>(), undefined, vp, 50, null)
    expect(got.recent.map((e) => e.id)).toEqual(['a', 'm'])
    expect(got.totalAll).toBe(2)
  })
})
