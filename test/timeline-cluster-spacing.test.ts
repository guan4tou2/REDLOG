// Two cluster marks in one lane never overlap.
//
// Measured in a real window with 300 HTTP flows in under an hour: buckets were
// 14px apart and every badge 16–24px wide, so each covered half of the next and
// "10" read as "1". These hold the drawn boxes apart, with a gap, for single
// dots and for counts up to four digits, at every density and track width.
import { describe, expect, it } from 'vitest'
import {
  buildClusters, clusterBadgeWidth, clusterBadgeSize, MARK_GAP_PX, MARK_HIT_PX, SINGLE_DOT_PX,
  type SingleMark, type TimelineCluster
} from '../src/renderer/src/lib/timelineGeometry'
import type { RedLogEvent } from '../src/core/db/event-types'

const CLUSTER_PX = 14 // Timeline.tsx
const LANE_H = 44

function evt(id: string, timestamp: number, agentType = 'http_flow', data: Record<string, unknown> = {}): RedLogEvent {
  return {
    id, timestamp, engagementId: 'eng-1', sessionId: 'ses-1', operatorId: 'op-1', agentType,
    hostname: 'localhost', sourceIP: null, targetId: null, data, hash: 'h', prevHash: null, createdAt: timestamp
  }
}

/** Deterministic PRNG (mulberry32) so a failing case can be replayed. */
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

const box = (c: TimelineCluster): [number, number] => [c.x + c.dx - c.w / 2, c.x + c.dx + c.w / 2]
const hitBox = (c: TimelineCluster): [number, number] => [c.x + c.dx - c.hitW / 2, c.x + c.dx + c.hitW / 2]

/** Every invariant the track relies on, for one buildClusters result.
 *  Problems are collected and asserted once: thousands of `expect` calls per
 *  generated case would make the property run slow, not stricter. */
function assertSound(clusters: TimelineCluster[], rows: Record<string, RedLogEvent[]>, order: string[], toX: (ts: number) => number, label: string): void {
  const bad: string[] = []
  const EPS = 1e-9
  order.forEach((row, li) => {
    const lane = clusters.filter((c) => c.li === li)
    const input = rows[row] ?? []
    // Membership: every event once, in draw order; counts add up.
    const flat = lane.flatMap((c) => c.events)
    if (flat.length !== input.length || flat.some((e, i) => e !== input[i])) bad.push(`${row}: membership`)
    lane.forEach((c, i) => {
      const n = c.events.length
      if (n === 1) {
        // A lone event sits at its own time.
        if (c.x !== toX(c.events[0].timestamp)) bad.push(`${row}#${i}: lone dot moved`)
      } else {
        const mean = c.events.reduce((a, e) => a + toX(e.timestamp), 0) / n
        if (Math.abs(c.x - mean) > 1e-6) bad.push(`${row}#${i}: x ${c.x} is not the mean ${mean}`)
        // The number fits: 7px a digit plus 4px each side.
        if (c.w < String(n).length * 7 + 8 || c.w !== clusterBadgeWidth(n)) bad.push(`${row}#${i}: width ${c.w} for ${n}`)
      }
      // The click area holds the whole mark, and asks for no more than before.
      const [l, r] = box(c)
      const [hl, hr] = hitBox(c)
      if (hl > l + EPS || hr < r - EPS) bad.push(`${row}#${i}: hit area smaller than the mark`)
      if (c.hitW > Math.max(MARK_HIT_PX, c.w + 8) + EPS) bad.push(`${row}#${i}: hit area too wide`)
      if (i > 0) {
        const p = lane[i - 1]
        const gap = l - box(p)[1]
        if (gap < MARK_GAP_PX - EPS) bad.push(`${row}#${i - 1}/${i} (${p.events.length}, ${n}): gap ${gap.toFixed(2)}`)
        // No click area reaches over its neighbour's.
        if (hl < hitBox(p)[1] - EPS) bad.push(`${row}#${i - 1}/${i}: hit areas overlap`)
      }
    })
  })
  expect(bad.slice(0, 5), label).toEqual([])
}

describe('cluster marks never overlap', () => {
  it('the measured window: 300 flows over 50 minutes on a 1180px track', () => {
    const span = 50 * 60_000
    const trackW = 1180
    const toX = (ts: number): number => (ts / span) * trackW
    const flows = Array.from({ length: 300 }, (_, i) => evt(`f${i}`, i * 10_000))
    const clusters = buildClusters(['http_flow'], { http_flow: flows }, toX, LANE_H, CLUSTER_PX, undefined)
    assertSound(clusters, { http_flow: flows }, ['http_flow'], toX, 'measured')
    // Fewer, fuller badges than the 85 14px buckets that overlapped.
    expect(clusters.length).toBeLessThan(85)
  })

  it('holds for counts crossing 9 → 10 → 100 → 1000 → 9999', () => {
    const toX = (ts: number): number => ts / 10 // 10ms = 1px
    for (const n of [1, 2, 9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999]) {
      const w = n === 1 ? SINGLE_DOT_PX : clusterBadgeWidth(n)
      // n coincident events, then a lone dot exactly one gap clear of the
      // badge, then another just inside it.
      // At x=139, the last pixel of a 14px column, so the lone dot is in the
      // next column and only the overlap check can merge it.
      const burst = Array.from({ length: n }, (_, i) => evt(`b${n}-${i}`, 1390))
      const clearX = 139 + w / 2 + MARK_GAP_PX + SINGLE_DOT_PX / 2
      const clear = evt(`clear${n}`, clearX * 10)
      const rows = { http_flow: [...burst, clear] }
      const cs = buildClusters(['http_flow'], rows, toX, LANE_H, CLUSTER_PX, undefined)
      assertSound(cs, rows, ['http_flow'], toX, `n=${n}`)
      expect(cs.map((c) => c.events.length)).toEqual([n, 1])

      const close = evt(`close${n}`, (clearX - 0.5) * 10)
      const rows2 = { http_flow: [...burst, close] }
      const cs2 = buildClusters(['http_flow'], rows2, toX, LANE_H, CLUSTER_PX, undefined)
      assertSound(cs2, rows2, ['http_flow'], toX, `n=${n} close`)
      expect(cs2.map((c) => c.events.length)).toEqual([n + 1])
    }
  })

  it('badges widen with digits and keep their old height', () => {
    expect([2, 9, 10, 99, 100, 999, 1000, 9999].map(clusterBadgeWidth)).toEqual([16, 23, 23, 24, 29, 29, 36, 36])
    expect(clusterBadgeSize(1000)).toBe(24)
  })

  it('holds over generated sets: uniform, bursts and mixed, 1–5000 events, several widths', () => {
    const random = rng(0x5eed)
    const span = 3_600_000
    const shapes = ['uniform', 'bursts', 'mixed'] as const
    let cases = 0
    for (const trackW of [320, 800, 1180, 2400, 12_000, 60_000]) {
      for (const shape of shapes) {
        for (const n of [1, 2, 3, 17, 300, 1200, 5000]) {
          const ts: number[] = []
          if (shape === 'uniform') {
            for (let i = 0; i < n; i++) ts.push(Math.round((i * span) / n))
          } else if (shape === 'bursts') {
            const centres = Array.from({ length: 1 + Math.floor(random() * 6) }, () => random() * span)
            for (let i = 0; i < n; i++) ts.push(Math.round(centres[i % centres.length] + random() * 2000))
          } else {
            for (let i = 0; i < n; i++) ts.push(random() < 0.3 ? Math.round(span / 2 + random() * 500) : Math.round(random() * span))
          }
          ts.sort((a, b) => a - b)
          const toX = (t: number): number => (t / span) * trackW
          const rows = { http_flow: ts.map((t, i) => evt(`g${i}`, t)) }
          const cs = buildClusters(['http_flow'], rows, toX, LANE_H, CLUSTER_PX, undefined)
          assertSound(cs, rows, ['http_flow'], toX, `${shape} n=${n} w=${trackW}`)
          cases++
        }
      }
    }
    expect(cases).toBe(6 * 3 * 7)
  })

  it('accounts for enlarged and indented single dots', () => {
    // A critical marker (14px) and an indented subagent turn sit beside plain dots.
    const mark = (e: RedLogEvent): SingleMark => ({
      w: e.agentType === 'marker' ? 14 : SINGLE_DOT_PX,
      dx: e.agentType === 'agent' ? 12 : 0
    })
    const toX = (ts: number): number => ts
    const random = rng(7)
    const types = ['shell', 'marker', 'agent']
    const rows = {
      shell: Array.from({ length: 2000 }, (_, i) => evt(`m${i}`, i * 11 + Math.floor(random() * 4), types[Math.floor(random() * 3)]))
    }
    const cs = buildClusters(['shell'], rows, toX, LANE_H, CLUSTER_PX, undefined, mark)
    // assertSound checks single dots by the default width, so check boxes here.
    expect(cs.flatMap((c) => c.events)).toEqual(rows.shell)
    for (let i = 1; i < cs.length; i++) {
      expect(box(cs[i])[0] - box(cs[i - 1])[1]).toBeGreaterThanOrEqual(MARK_GAP_PX - 1e-9)
    }
    for (const c of cs.filter((k) => k.events.length === 1)) {
      expect(c.w).toBe(mark(c.events[0]).w)
      expect(c.dx).toBe(mark(c.events[0]).dx)
    }
  })

  it('leaves plain dots that the zoom ceiling opened to 14px apart as dots', () => {
    // computeMaxZoom opens the tightest gap to CLUSTER_PX; those must split.
    const toX = (ts: number): number => ts
    const rows = { http_flow: Array.from({ length: 50 }, (_, i) => evt(`z${i}`, i * CLUSTER_PX)) }
    const cs = buildClusters(['http_flow'], rows, toX, LANE_H, CLUSTER_PX, undefined)
    expect(cs).toHaveLength(50)
    assertSound(cs, rows, ['http_flow'], toX, 'max zoom')
  })

  it('holds per lane in the multi-lane mode', () => {
    const random = rng(42)
    const order = ['shell', 'http_flow', 'dns']
    const rows: Record<string, RedLogEvent[]> = {}
    for (const row of order) {
      rows[row] = Array.from({ length: 800 }, () => Math.round(random() * 3_600_000)).sort((a, b) => a - b).map((t, i) => evt(`${row}${i}`, t, row))
    }
    const toX = (t: number): number => (t / 3_600_000) * 1180
    const cs = buildClusters(order, rows, toX, LANE_H, CLUSTER_PX, undefined)
    assertSound(cs, rows, order, toX, 'lanes')
  })
})
