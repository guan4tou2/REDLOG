import { buildCommandIntervals } from '../src/renderer/src/lib/timelineIntervals'
import { makeEvent } from './helpers/timeline-bridge'
import { expect, it } from 'vitest'
import type { TimelineInterval, TimelineIntervalSet } from '../src/renderer/src/lib/timelineIntervals'
import { layoutIntervalMarks, filterVisibleMarks } from '../src/renderer/src/lib/timelineIntervalLayout'

function interval(id: string, start: number, end: number | null, extra: Partial<TimelineInterval> = {}): TimelineInterval {
  return { id, kind: 'command', trackKey: 't', startId: `${id}s`, startTs: start,
    endId: end === null ? null : `${id}e`, endTs: end, endBasis: end === null ? 'open' : 'observed',
    supersededById: null, anchorId: id, memberIds: [id], command: 'nmap', exitCode: end === null ? null : 0,
    reportedDurationSec: null, reversed: end !== null && end < start, ...extra }
}
function layout(intervals: TimelineInterval[], extra = {}) {
  const set: TimelineIntervalSet = { intervals, tracks: [], claimed: new Set(), byMemberId: new Map() }
  return layoutIntervalMarks({ set, rowOf: new Map([['t', 1]]), toX: (t) => t, trackW: 1000, laneH: 44, clusterPx: 14, endsMayBeMissing: false, ...extra })
}
it('an interval narrower than 14px is a point, not a span', () => {
  expect(layout([interval('a', 100, 113)])[0]?.kind).toBe('point')
  expect(layout([interval('a', 100, 113)])[0]?.x1).toBe(100)
})

it('merges starts in one 14px cell, counts commands and draws their union', () => {
  const m = layout([interval('a', 28, 31), interval('b', 35, 90, { exitCode: 2 })])
  expect(m).toHaveLength(1)
  expect(m[0]).toMatchObject({ kind: 'cluster', x0: 28, x1: 90, failed: 1, endCap: 'failed', label: null })
  expect(m[0].intervals).toHaveLength(2)
  expect(layout([interval('a', 28, 30), interval('b', 31, 33)])[0]).toMatchObject({ kind: 'cluster', x0: 28, x1: 28 })
})
it('a count takes the starts inside its own footprint, so two counts never overlap', () => {
  // Twenty one-second commands 3px apart. Cells alone gave a count every
  // 14px: 16px badges on top of each other, a failed one's cross under the next.
  const m = layout(Array.from({ length: 20 }, (_, i) => interval(`c${i}`, 100 + i * 3, 101 + i * 3)))
  expect(m.map((x) => [x.kind, x.x0, x.intervals.length])).toEqual([['cluster', 100, 9], ['cluster', 127, 9], ['cluster', 154, 2]])
})
it('a mark that becomes a count is folded into the start dot it would cover', () => {
  // 13 is alone in its cell; 15 and 16 share the next one and become a count 2px away.
  const m = layout([interval('a', 13, 14), interval('b', 15, 16), interval('c', 16, 17, { exitCode: 1 })])
  expect(m).toHaveLength(1)
  expect(m[0]).toMatchObject({ kind: 'cluster', x0: 13, failed: 1 })
  expect(m[0].intervals.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  // Two lone starts in neighbouring cells stay two marks.
  expect(layout([interval('a', 13, 14), interval('b', 15, 16)])).toHaveLength(2)
})
it('caps depth at two by joining the most recently started span', () => {
  const m = layout([interval('a', 0, 300), interval('b', 28, 200), interval('c', 56, 400)])
  expect(m).toHaveLength(2)
  expect(m[1].intervals.map((i) => i.id)).toEqual(['b', 'c'])
  expect(m[1].x1).toBe(400)
})
it('open intervals run to the next start or the right edge and never acquire an end', () => {
  const m = layout([interval('a', 100, null), interval('b', 200, null)])
  expect(m.map((m) => [m.x1, m.endCap])).toEqual([[200, 'open'], [1000, 'open']])
})
it('endsMayBeMissing limits an open interval to a 16px stub', () => {
  expect(layout([interval('a', 100, null)], { endsMayBeMissing: true })[0]).toMatchObject({ x0: 100, x1: 116, endCap: 'open-stub' })
})
it('an unknown start draws only a 16px left stub, with its known end shape', () => {
  expect(layout([interval('a', 0, 200, { startTs: null, startId: null })])[0]).toMatchObject({ x0: 184, x1: 200, startCap: 'unloaded', endCap: 'ok' })
})
it('reversed time is a point at the actual start', () => {
  expect(layout([interval('a', 100, 50)])[0]).toMatchObject({ kind: 'point', x0: 100, x1: 100 })
})
it('names prefer right, use left when wider, and disappear when neither side has 48px', () => {
  expect(layout([interval('a', 100, 120), interval('b', 140, 150)])[0].label?.side).toBe('left')
  expect(layout([interval('a', 5, 8), interval('b', 40, 45)])[0].label).toBeNull()
  expect(layout([interval('a', 0, 20)], { trackW: 53 })[0].label).toBeNull()
  expect(layout([interval('a', 0, 20)], { trackW: 54 })[0].label).toEqual({ side: 'right', maxW: 48 })
  expect(layout([interval('a', 100, 120)])[0].label).toEqual({ side: 'right', maxW: 320 })
})
it('neighbouring names reserve disjoint horizontal space', () => {
  const m = layout([interval('a', 20, 40), interval('b', 100, 120), interval('c', 130, 150)])
  expect(m[0].label).toEqual({ side: 'right', maxW: 68 })
  expect(m[1].label).toBeNull() // the left gap already belongs to a's name
})
it('all four states are determined by observed evidence', () => {
  expect([0, 2, null].map((exitCode) => layout([interval('a', 100, 200, { exitCode })])[0].endCap)).toEqual(['ok', 'failed', 'no-result'])
  expect(layout([interval('a', 100, 200, { endBasis: 'superseded' })])[0].endCap).toBe('no-result')
})
it('filters horizontal geometry and visible rows plus one either side', () => {
  const m = layout([interval('a', 100, 200), interval('b', 300, 350)])
  expect(filterVisibleMarks(m, 1000, 150, 20, { first: 2, last: 2 }).map((m) => m.key)).toEqual(['a'])
  expect(filterVisibleMarks(m, 1000, 150, 20, { first: 3, last: 3 })).toEqual([])
})
it('SC-004: a thousand mutually overlapping commands obey depth and visible mark bounds', () => {
  const m = layout(Array.from({ length: 1000 }, (_, i) => interval(String(i), i * 15, 20000)), { trackW: 20000 })
  // The count also absorbs the first span when their starts are only 15px apart.
  expect(m).toHaveLength(1)
  expect(m.flatMap((m) => m.intervals)).toHaveLength(1000)
  for (const w of [1, 14, 48, 320, 1000]) {
    for (let left = 0; left < 20000; left += 137) {
      expect(filterVisibleMarks(m, 20000, left, w, { first: 1, last: 1 }).length).toBeLessThanOrEqual(Math.ceil(3 * w / 14) + 2)
    }
  }
})

it('SC-003: seeded loaded subsets never invent a start or an observed result', () => {
  let seed = 783003
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  for (let trial = 0; trial < 1000; trial++) {
    const rows = []
    for (let i = 0; i < 12; i++) {
      const command = `cmd ${i}`
      const data = { shell: 'zsh', terminalId: 't', command_id: String(i), command }
      if (rand() > 0.3) rows.push(makeEvent(`s${i}`, i * 100, 'shell', { data: { ...data, subtype: 'command_start' } }))
      if (rand() > 0.3) rows.push(makeEvent(`e${i}`, i * 100 + 50, 'shell', { data: { ...data, subtype: 'command_end', exit_code: i % 3 ? 0 : 2 } }))
    }
    const set = buildCommandIntervals(rows)
    const marks = layoutIntervalMarks({ set, rowOf: new Map([['terminal:t', 1]]), toX: (t) => t, trackW: 1300, laneH: 44, clusterPx: 14, endsMayBeMissing: false })
    expect(marks.length).toBeGreaterThan(0)
    const ids = new Set(rows.map((r) => r.id))
    for (const m of marks) {
      for (const iv of m.intervals) {
        if (iv.endBasis !== 'open') expect(ids.has(iv.endId ?? iv.supersededById!), `seed ${seed}`).toBe(true)
      }
      if (m.kind !== 'cluster') {
        const iv = m.intervals[0]
        if (iv.endBasis === 'open') expect(['open', 'open-stub']).toContain(m.endCap)
        if (iv.startTs !== null) expect(m.x0).toBe(iv.startTs)
        else expect(m.x0).toBe(iv.endTs! - 16)
      }
    }
  }
})

it('open lines skip duplicate starts even with an end-only interval between them', () => {
  const m = layout([interval('a', 100, null), interval('orphan', 0, 100, { startTs: null, startId: null }), interval('b', 100, null), interval('c', 300, 400)])
  const open = m.flatMap((m) => m.intervals.filter((iv) => iv.endBasis === 'open').map(() => m))
  expect(open.every((m) => m.x1 === 300)).toBe(true)
})
it('SC-004 also bounds short bursts and partially overlapping spans at arbitrary view edges', () => {
  let seed = 784004
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const intervals = Array.from({ length: 1000 }, (_, i) => interval(String(i), i * 3, i * 3 + Math.floor(rand() * 250)))
  const marks = layout(intervals, { trackW: 4000 })
  expect(marks.flatMap((m) => m.intervals)).toHaveLength(1000)
  for (let i = 0; i < 1000; i++) {
    const x = rand() * 4000, w = 1 + rand() * 100
    expect(marks.filter((m) => m.x0 <= x && m.x1 > x).length).toBeLessThanOrEqual(2)
    expect(filterVisibleMarks(marks, 4000, x, w, { first: 1, last: 1 }).length).toBeLessThanOrEqual(Math.ceil(3 * w / 14) + 2)
  }
})

it('depth-cap counts absorb neighbouring starts and hit areas meet at their midpoint', () => {
  // The first two starts occupy neighbouring cells. Only the depth cap turns
  // the second span into a count, which would cover the first start at 13px.
  const depth = layout([interval('a', 13, 300), interval('b', 15, 200), interval('c', 56, 400)])
  expect(depth, 'depth-created count cannot cover a neighbouring dot').toHaveLength(1)
  expect(depth[0].intervals.map(iv => iv.id)).toEqual(['a', 'b', 'c'])
  const marks = layout([interval('a', 100, 101), interval('b', 103, 104), interval('c', 160, 161)])
  for (const m of marks) expect(m.hitWidth).toBeGreaterThanOrEqual(27)
  const [count, next] = marks
  const midpoint = (count.x0 + next.x0) / 2
  expect(count.hitLeft + count.hitWidth, 'count hit ends at midpoint').toBe(midpoint)
  expect(next.hitLeft, 'neighbour hit begins at midpoint').toBe(midpoint)
})
it('an open span reaches the right edge without adding horizontal overflow through its hit box', () => {
  const [m] = layout([interval('a', 100, null)])
  expect(m.x1).toBe(1000)
  expect(m.hitLeft + m.hitWidth, 'right-edge hit area stays within the track').toBeLessThanOrEqual(1000)
  expect(m.hitWidth).toBeGreaterThanOrEqual(27)
})
