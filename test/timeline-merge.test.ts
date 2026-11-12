import { describe, expect, it } from 'vitest'
import type { RedLogEvent } from '../src/core/db/event-types'
import { mergeSortedRows } from '../src/renderer/src/lib/timelineMerge'
import { binarySearchInsert, eventCompare } from '../src/renderer/src/lib/timelineDomain'

// Paged history used to be merged one `binarySearchInsert` per row, each
// shifting the whole store when the page is older than everything held. The
// merge must leave the store and the id map exactly as those inserts did.

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const row = (id: string, timestamp: number, more: Partial<RedLogEvent> = {}): RedLogEvent =>
  ({ id, timestamp, agentType: 'shell', data: {}, tier: 'chained', ...more }) as unknown as RedLogEvent
/** A mix of everything a store can hold in one millisecond: rows from either
 *  tier, with and without the rowId a page read carries, with and without a
 *  monotonic stamp (which the order no longer reads). */
function mixed(r: () => number): Partial<RedLogEvent> {
  return {
    tier: r() < 0.5 ? 'chained' : 'logged',
    ...(r() < 0.7 ? { rowId: 1 + Math.floor(r() * 6) } : {}),
    ...(r() < 0.3 ? { monotonicNs: String(Math.floor(r() * 1e6)) } : {})
  }
}

function reference(sorted: RedLogEvent[], byId: Map<string, RedLogEvent>, rows: readonly RedLogEvent[]): void {
  for (const e of rows) {
    if (!byId.has(e.id)) binarySearchInsert(sorted, e)
    byId.set(e.id, e)
  }
}

describe('mergeSortedRows', () => {
  for (const [label, shape] of [
    ['older pages (paging back)', 'older'],
    ['newer pages', 'newer'],
    ['interleaved pages', 'mixed'],
    ['pages with rows already held and shared timestamps', 'dupes']
  ] as const) {
    it(`matches one binarySearchInsert per row: ${label}`, () => {
      for (const seed of [1, 2, 3, 99]) {
        const r = rng(seed)
        const a: RedLogEvent[] = [], b: RedLogEvent[] = []
        const mapA = new Map<string, RedLogEvent>(), mapB = new Map<string, RedLogEvent>()
        let held = b
        let n = 0
        let older = 1_000_000, newer = 1_000_000
        for (let page = 0; page < 40; page++) {
          const rows: RedLogEvent[] = []
          const size = Math.floor(r() * 30)
          for (let k = 0; k < size; k++) {
            if (shape === 'dupes' && n > 0 && r() < 0.3) { rows.push(row(`e${Math.floor(r() * n)}`, 0)); continue }
            const ts = shape === 'older' ? (older -= Math.floor(r() * 3))
              : shape === 'newer' ? (newer += Math.floor(r() * 3))
              : Math.floor(r() * 40)
            // Timestamps are drawn close together so most rows share a
            // millisecond with others, and every mix of tie-break fields meets
            // every other. eventCompare is a strict weak order over any mix, so
            // there is one sorted arrangement and both paths must reach it.
            rows.push(row(`e${n++}`, shape === 'dupes' ? Math.floor(r() * 20) : ts, mixed(r)))
          }
          // A page arrives newest first, as the query returns it.
          if (shape === 'older') rows.reverse()
          reference(a, mapA, rows)
          held = mergeSortedRows(held, mapB, rows)
          expect(held.map((e) => e.id)).toEqual(a.map((e) => e.id))
          expect([...mapB]).toEqual([...mapA])
          for (let i = 1; i < held.length; i++) expect(eventCompare(held[i - 1], held[i])).toBeLessThan(0)
        }
      }
    })
  }

  it('orders a same-millisecond pair by ingestion, whichever arrives first and whatever the ids', () => {
    // A logged request/response pair carries no monotonic stamp; ids sort the wrong way.
    const req = row('z-req', 5, { tier: 'logged', rowId: 40 }), resp = row('a-resp', 5, { tier: 'logged', rowId: 41 })
    for (const arrival of [[req, resp], [resp, req]]) {
      const sorted: RedLogEvent[] = []
      for (const e of arrival) binarySearchInsert(sorted, e)
      expect(sorted.map(e => e.id)).toEqual(['z-req', 'a-resp'])
      expect(mergeSortedRows([], new Map(), arrival).map(e => e.id)).toEqual(['z-req', 'a-resp'])
    }
  })

  it('returns the held array itself when the page brings nothing new', () => {
    const held = [row('a', 1), row('b', 2)]
    const map = new Map(held.map((e) => [e.id, e]))
    expect(mergeSortedRows(held, map, [row('a', 1)])).toBe(held)
  })
})
