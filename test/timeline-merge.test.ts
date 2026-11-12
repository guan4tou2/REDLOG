import { describe, expect, it } from 'vitest'
import type { RedLogEvent } from '../src/core/db/event-types'
import { mergeSortedRows } from '../src/renderer/src/lib/timelineMerge'
import { binarySearchInsert } from '../src/renderer/src/lib/timelineDomain'

// Paged history used to be merged one `binarySearchInsert` per row, each
// shifting the whole store when the page is older than everything held. The
// merge must leave the store and the id map exactly as those inserts did.

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const row = (id: string, timestamp: number, monotonicNs?: string): RedLogEvent =>
  ({ id, timestamp, agentType: 'shell', data: {}, ...(monotonicNs ? { monotonicNs } : {}) }) as unknown as RedLogEvent

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
            const ts = shape === 'older' ? (older -= Math.floor(r() * 50))
              : shape === 'newer' ? (newer += Math.floor(r() * 50))
              : Math.floor(r() * 2_000_000)
            // Rows sharing a millisecond either all carry monotonicNs or none
            // do: with a mix, eventCompare is not transitive (eventOrder.ts
            // answers 0 when one side lacks it), so no order is "the" sorted
            // one and the per-row inserts were already arrival-dependent.
            rows.push(row(`e${n++}`, shape === 'dupes' ? Math.floor(r() * 20) : ts, shape !== 'dupes' && r() < 0.3 ? String(Math.floor(r() * 1e6)) : undefined))
          }
          // A page arrives newest first, as the query returns it.
          if (shape === 'older') rows.reverse()
          reference(a, mapA, rows)
          held = mergeSortedRows(held, mapB, rows)
          expect(held.map((e) => e.id)).toEqual(a.map((e) => e.id))
          expect([...mapB]).toEqual([...mapA])
        }
      }
    })
  }

  it('returns the held array itself when the page brings nothing new', () => {
    const held = [row('a', 1), row('b', 2)]
    const map = new Map(held.map((e) => [e.id, e]))
    expect(mergeSortedRows(held, map, [row('a', 1)])).toBe(held)
  })
})
