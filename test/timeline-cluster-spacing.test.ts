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
import { displayTs } from '../src/renderer/src/lib/timelineDomain'
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
    // Draw order: a swim-lane row arrives in capture order and is drawn by
    // display time (a stable sort, as buildClusters does).
    const input = [...(rows[row] ?? [])].sort((a, b) => displayTs(a) - displayTs(b))
    // Membership: every event once, in draw order; counts add up.
    const flat = lane.flatMap((c) => c.events)
    if (flat.length !== input.length || flat.some((e, i) => e !== input[i])) bad.push(`${row}: membership`)
    lane.forEach((c, i) => {
      const n = c.events.length
      if (n === 1) {
        // A lone event sits at its own time.
        if (c.x !== toX(displayTs(c.events[0]))) bad.push(`${row}#${i}: lone dot moved`)
      } else {
        const mean = c.events.reduce((a, e) => a + toX(displayTs(e)), 0) / n
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
        const badges = (p.events.length > 1 ? 1 : 0) + (n > 1 ? 1 : 0)
        // Two badges keep the gap; a badge and a dot may touch, never cross.
        // Two lone dots may overlap: they only have to stay in time order.
        if (badges === 2 && gap < MARK_GAP_PX - EPS) bad.push(`${row}#${i - 1}/${i} badges (${p.events.length}, ${n}): gap ${gap.toFixed(2)}`)
        if (badges === 1 && gap < -EPS) bad.push(`${row}#${i - 1}/${i} badge and dot (${p.events.length}, ${n}): overlap ${gap.toFixed(2)}`)
        if (badges === 0 && !(c.x > p.x)) bad.push(`${row}#${i - 1}/${i}: dots out of order`)
        // No click area reaches over a badge's, or a badge's over anything.
        if (badges > 0 && hl < hitBox(p)[1] - EPS) bad.push(`${row}#${i - 1}/${i}: hit areas overlap`)
      }
    })
  })
  expect(bad.slice(0, 5), label).toEqual([])
  expect(singlesFolded(clusters, toX), `${label}: lone dots folded together`).toEqual([])
}

/**
 * Clusters made only of 14px buckets that each held one event. A lone dot
 * joins a cluster only through a badge, so every multi-event cluster must
 * contain at least one bucket that already held two or more.
 */
function singlesFolded(clusters: TimelineCluster[], toX: (ts: number) => number): string[] {
  const perBucket = new Map<string, number>()
  const id = (c: TimelineCluster, e: RedLogEvent): string => `${c.li}:${Math.floor(toX(displayTs(e)) / CLUSTER_PX)}`
  for (const c of clusters) for (const e of c.events) perBucket.set(id(c, e), (perBucket.get(id(c, e)) ?? 0) + 1)
  return clusters
    .filter((c) => c.events.length > 1 && c.events.every((e) => perBucket.get(id(c, e)) === 1))
    .map((c) => `${c.events.length} lone dots at x=${c.x.toFixed(1)}`)
}

describe('cluster marks never overlap', () => {
  it('the measured window: 300 flows over 50 minutes on a 1180px track', () => {
    const span = 50 * 60_000
    const trackW = 1180
    const toX = (ts: number): number => (ts / span) * trackW
    const flows = Array.from({ length: 300 }, (_, i) => evt(`f${i}`, i * 10_000))
    const clusters = buildClusters(['http_flow'], { http_flow: flows }, toX, LANE_H, CLUSTER_PX, undefined)
    assertSound(clusters, { http_flow: flows }, ['http_flow'], toX, 'measured')
    // Fewer, fuller badges than the 85 14px buckets that overlapped, but
    // pairs of buckets rather than one cluster growing leftwards: 43 marks.
    expect(clusters.length).toBe(43)
  })

  it('holds for counts crossing 9 → 10 → 100 → 1000 → 9999', () => {
    const toX = (ts: number): number => ts / 10 // 10ms = 1px
    for (const n of [1, 2, 9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999]) {
      const w = n === 1 ? SINGLE_DOT_PX : clusterBadgeWidth(n)
      // n coincident events, then a lone dot just touching the badge, then
      // another half a pixel inside it.
      // At x=139, the last pixel of a 14px column, so the lone dot is in the
      // next column and only the overlap check can merge it.
      const burst = Array.from({ length: n }, (_, i) => evt(`b${n}-${i}`, 1390))
      const clearX = 139 + w / 2 + SINGLE_DOT_PX / 2
      const clear = evt(`clear${n}`, clearX * 10)
      const rows = { http_flow: [...burst, clear] }
      const cs = buildClusters(['http_flow'], rows, toX, LANE_H, CLUSTER_PX, undefined)
      assertSound(cs, rows, ['http_flow'], toX, `n=${n}`)
      expect(cs.map((c) => c.events.length)).toEqual([n, 1])

      const close = evt(`close${n}`, (clearX - 0.5) * 10)
      const rows2 = { http_flow: [...burst, close] }
      const cs2 = buildClusters(['http_flow'], rows2, toX, LANE_H, CLUSTER_PX, undefined)
      assertSound(cs2, rows2, ['http_flow'], toX, `n=${n} close`)
      // A badge swallows a dot it covers; two dots stay two.
      expect(cs2.map((c) => c.events.length)).toEqual(n === 1 ? [1, 1] : [n + 1])
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
      const badges = (cs[i].events.length > 1 ? 1 : 0) + (cs[i - 1].events.length > 1 ? 1 : 0)
      const gap = box(cs[i])[0] - box(cs[i - 1])[1]
      if (badges === 2) expect(gap).toBeGreaterThanOrEqual(MARK_GAP_PX - 1e-9)
      else if (badges === 1) expect(gap).toBeGreaterThanOrEqual(-1e-9)
      else expect(cs[i].x).toBeGreaterThan(cs[i - 1].x)
    }
    expect(singlesFolded(cs, toX)).toEqual([])
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

// The two e2e seeds that broke when lone dots could be folded into a badge,
// rebuilt from the specs' own numbers. Swim-lane rows arrive in capture
// order: a marker's `atTimestamp` (or a row's `source_timestamp`) puts it far
// left of where it sits in the row, and the old merge read that backwards step
// as a collision and folded everything after it into one badge.
describe('the e2e seeds keep their marks', () => {
  const T = 1_800_000_000_000
  const marker = (id: string, receipt: number, at: number, extra: Record<string, unknown> = {}): RedLogEvent =>
    evt(id, receipt, 'marker', { atTimestamp: at, ...extra })
  /** computeDomainBounds: first..last display time, padded 5% or 60s a side. */
  const linear = (rows: RedLogEvent[], trackW: number): ((ts: number) => number) => {
    const ds = rows.map(displayTs)
    const first = Math.min(...ds)
    const last = Math.max(...ds)
    const pad = Math.max((last - first) * 0.05, 60_000)
    return (ts) => ((ts - (first - pad)) / (last - first + 2 * pad)) * trackW
  }
  const lone = (cs: TimelineCluster[], id: string): TimelineCluster | undefined =>
    cs.find((c) => c.events.length === 1 && c.events[0].id === id)

  // timeline-track.spec.ts "timeline-encoding": one collapsed band holds the
  // markers, the scope observation and the project's genesis rows.
  it('timeline-encoding: info, important and critical stay three dots', () => {
    for (const trackW of [600, 900, 1180, 1400, 1600]) {
      for (const genesis of [1, 2, 3, 4]) {
        const row = [
          evt('scope', T - 15 * 60_000, 'system', { subtype: 'scope_violation', description: 'out of scope: evil.example' }),
          ...Array.from({ length: genesis }, (_, i) => evt(`gen${i}`, T - 6_000 + i, 'system', { subtype: 'session_start' })),
          marker('info', T - 3_000, T - 40 * 60_000, { severity: 'info' }),
          marker('important', T - 2_900, T - 25 * 60_000, { severity: 'important' }),
          marker('critical', T - 2_800, T - 10 * 60_000, { severity: 'critical' })
        ]
        const toX = linear(row, trackW)
        const sizes: Record<string, number> = { important: 11, critical: 14, scope: 11 }
        const mark = (e: RedLogEvent): SingleMark => ({ w: sizes[e.id] ?? SINGLE_DOT_PX, dx: 0 })
        const cs = buildClusters(['signals'], { signals: row }, toX, LANE_H, CLUSTER_PX, undefined, mark)
        for (const id of ['info', 'important', 'critical', 'scope']) {
          expect(lone(cs, id), `${id} at ${trackW}px with ${genesis} genesis rows`).toBeTruthy()
          expect(lone(cs, id)!.x).toBe(toX(displayTs(row.find((e) => e.id === id)!)))
        }
      }
    }
  })

  // timeline-evidence.spec.ts "event-causal-chain": after focus loads the
  // parent, the row is genesis, parent, 205 fillers, effect.
  it('event-causal-chain: the causal parent and effect stay their own marks', () => {
    for (const trackW of [600, 900, 1180, 1400, 1600]) {
      const row = [
        evt('gen0', T - 12_000, 'system', { subtype: 'session_start' }),
        evt('gen1', T - 12_000 + 1, 'system', { subtype: 'session_start' }),
        marker('parent', T - 11_000, T - 3_600_000, { title: 'causal parent' }),
        ...Array.from({ length: 205 }, (_, i) => marker(`filler${i}`, T - 10_000 + i * 40, T - 2_000_000 + i * 5_000, { title: `filler ${i}` })),
        marker('effect', T - 1_000, T - 120_000, { title: 'causal effect', _causes: ['parent'] })
      ]
      const toX = linear(row, trackW)
      const cs = buildClusters(['marker'], { marker: row }, toX, LANE_H, CLUSTER_PX, undefined)
      expect(lone(cs, 'parent'), `parent at ${trackW}px`).toBeTruthy()
      expect(lone(cs, 'effect'), `effect at ${trackW}px`).toBeTruthy()
      assertSound(cs, { marker: row }, ['marker'], toX, `causal ${trackW}`)
    }
  })

  it('a row out of display order is clustered as if it were in order', () => {
    const random = rng(99)
    const row = Array.from({ length: 1500 }, (_, i) => marker(`o${i}`, T + i, T - Math.round(random() * 3_600_000)))
    const toX = linear(row, 1180)
    const cs = buildClusters(['marker'], { marker: row }, toX, LANE_H, CLUSTER_PX, undefined)
    const sorted = [...row].sort((a, b) => displayTs(a) - displayTs(b))
    expect(cs.map((c) => c.events.map((e) => e.id))).toEqual(
      buildClusters(['marker'], { marker: sorted }, toX, LANE_H, CLUSTER_PX, undefined).map((c) => c.events.map((e) => e.id)))
    assertSound(cs, { marker: row }, ['marker'], toX, 'out of order')
  })
})

describe('lone dots are never folded together', () => {
  it('one mark per event when no 14px bucket holds two, whatever their sizes', () => {
    const random = rng(2024)
    for (let round = 0; round < 40; round++) {
      // One event per bucket, anywhere inside it: neighbours 0–28px apart.
      const n = 50 + Math.floor(random() * 400)
      const row = Array.from({ length: n }, (_, i) => evt(`s${round}-${i}`, i * CLUSTER_PX + Math.floor(random() * CLUSTER_PX), random() < 0.3 ? 'marker' : 'shell'))
      const sizes = new Map(row.map((e) => [e.id, {
        w: e.agentType === 'marker' ? [9, 11, 14][Math.floor(random() * 3)] : SINGLE_DOT_PX,
        dx: random() < 0.2 ? 12 : 0
      }]))
      const mark = (e: RedLogEvent): SingleMark => sizes.get(e.id) as SingleMark
      const toX = (ts: number): number => ts
      const cs = buildClusters(['r'], { r: row }, toX, LANE_H, CLUSTER_PX, undefined, mark)
      expect(cs).toHaveLength(n)
      // Each keeps its full hit area; the later one sits on top, as before.
      expect(cs.every((c) => c.hitW === Math.max(MARK_HIT_PX, c.w + 8))).toBe(true)
    }
  })
})
