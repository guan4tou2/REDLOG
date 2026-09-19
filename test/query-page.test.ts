import { describe, it, expect } from 'vitest'
import {
  encodeCursor, decodeCursor, buildCursorWhere,
  toQueryPage, CANONICAL_ORDER,
  type CursorKey, type QueryPage
} from '../src/core/query-page'

// --- encode / decode ---

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a valid cursor', () => {
    const key: CursorKey = { ts: 1726700000000, row: 42, tier: 'chained' }
    const encoded = encodeCursor(key)
    expect(typeof encoded).toBe('string')
    expect(encoded).not.toContain('{')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual(key)
  })

  it('round-trips logged tier', () => {
    const key: CursorKey = { ts: 0, row: 1, tier: 'logged' }
    expect(decodeCursor(encodeCursor(key))).toEqual(key)
  })

  it('returns null for garbage input', () => {
    expect(decodeCursor('not-valid-base64!!')).toBeNull()
  })

  it('returns null for valid base64 but wrong shape', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: 'wrong' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('returns null for missing tier', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: 1, row: 2 })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('returns null for invalid tier value', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: 1, row: 2, tier: 'other' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('returns null for wrong version', () => {
    const bad = Buffer.from(JSON.stringify({ v: 99, ts: 1, row: 1, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('returns null for no version', () => {
    const bad = Buffer.from(JSON.stringify({ ts: 1, row: 1, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects negative timestamp', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: -1, row: 1, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects row < 1', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: 1, row: 0, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects non-integer timestamp (float)', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: 1.5, row: 1, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects Infinity', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, ts: Infinity, row: 1, tier: 'chained' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('cursor is opaque (not human-readable)', () => {
    const encoded = encodeCursor({ ts: 123, row: 1, tier: 'chained' })
    expect(encoded).not.toMatch(/timestamp|chained/)
  })
})

// --- buildCursorWhere ---

describe('buildCursorWhere', () => {
  it('generates a 3-level keyset predicate', () => {
    const cursor: CursorKey = { ts: 5000, row: 10, tier: 'chained' }
    const { sql, params } = buildCursorWhere(cursor)
    expect(sql).toContain('timestamp < ?')
    expect(sql).toContain('_row < ?')
    expect(sql).toContain('tier_rank < ?')
    expect(params).toEqual([5000, 5000, 10, 5000, 10, 1])
  })

  it('logged tier has rank 0', () => {
    const { params } = buildCursorWhere({ ts: 1, row: 1, tier: 'logged' })
    expect(params[params.length - 1]).toBe(0)
  })

  it('chained tier has rank 1', () => {
    const { params } = buildCursorWhere({ ts: 1, row: 1, tier: 'chained' })
    expect(params[params.length - 1]).toBe(1)
  })

  it('accepts custom tierExpr', () => {
    const { sql } = buildCursorWhere({ ts: 1, row: 1, tier: 'chained' }, 'my_rank')
    expect(sql).toContain('my_rank < ?')
  })
})

// --- toQueryPage ---

describe('toQueryPage', () => {
  const extract = (item: { ts: number; row: number; tier: 'chained' | 'logged' }): CursorKey =>
    ({ ts: item.ts, row: item.row, tier: item.tier })

  it('hasMore=true when rows > limit, returns first limit items', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ts: 100 - i, row: i, tier: 'chained' as const
    }))
    const page = toQueryPage(rows, 5, extract)
    expect(page.items).toHaveLength(5)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).not.toBeNull()
  })

  it('hasMore=false when rows <= limit', () => {
    const rows = [
      { ts: 100, row: 1, tier: 'chained' as const },
      { ts: 99, row: 2, tier: 'logged' as const }
    ]
    const page = toQueryPage(rows, 5, extract)
    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  })

  it('hasMore=false for empty result', () => {
    const page = toQueryPage([], 5, extract)
    expect(page.items).toHaveLength(0)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  })

  it('hasMore=true when rows = limit+1 exactly', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      ts: 100 - i, row: i, tier: 'chained' as const
    }))
    const page = toQueryPage(rows, 3, extract)
    expect(page.items).toHaveLength(3)
    expect(page.hasMore).toBe(true)
  })

  it('hasMore=false when rows = limit exactly', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ts: 100 - i, row: i, tier: 'chained' as const
    }))
    const page = toQueryPage(rows, 3, extract)
    expect(page.items).toHaveLength(3)
    expect(page.hasMore).toBe(false)
  })

  it('nextCursor encodes last item of page, not the extra row', () => {
    const rows = [
      { ts: 100, row: 1, tier: 'chained' as const },
      { ts: 99, row: 2, tier: 'logged' as const },
      { ts: 98, row: 3, tier: 'chained' as const }  // extra row
    ]
    const page = toQueryPage(rows, 2, extract)
    const cursor = decodeCursor(page.nextCursor!)
    expect(cursor).toEqual({ ts: 99, row: 2, tier: 'logged' })
  })
})

// --- Property-based tests (manual generation) ---

describe('pagination properties', () => {
  type Row = { id: string; ts: number; row: number; tier: 'chained' | 'logged' }
  const extract = (r: Row): CursorKey => ({ ts: r.ts, row: r.row, tier: r.tier })
  const TIER_RANK: Record<string, number> = { chained: 1, logged: 0 }

  function canonicalSort(rows: Row[]): Row[] {
    return [...rows].sort((a, b) => {
      if (a.ts !== b.ts) return b.ts - a.ts
      if (a.row !== b.row) return b.row - a.row
      return TIER_RANK[b.tier] - TIER_RANK[a.tier]
    })
  }

  // Simulate paginating by filtering with cursor predicate
  function paginate(allRows: Row[], pageSize: number): Row[][] {
    const sorted = canonicalSort(allRows)
    const pages: Row[][] = []
    let cursor: CursorKey | null = null

    for (let safety = 0; safety < 1000; safety++) {
      let slice: Row[]
      if (!cursor) {
        slice = sorted.slice(0, pageSize + 1)
      } else {
        slice = sorted.filter(r => {
          if (r.ts < cursor!.ts) return true
          if (r.ts === cursor!.ts && r.row < cursor!.row) return true
          if (r.ts === cursor!.ts && r.row === cursor!.row && TIER_RANK[r.tier] < TIER_RANK[cursor!.tier]) return true
          return false
        }).slice(0, pageSize + 1)
      }

      const page = toQueryPage(slice, pageSize, extract)
      pages.push(page.items)
      if (!page.hasMore || !page.nextCursor) break
      cursor = decodeCursor(page.nextCursor)
    }
    return pages
  }

  // Generate deterministic but varied test data.
  // In real SQLite, rowid is unique per table (tier). We enforce the same
  // constraint here: within each tier, row values are unique. Across tiers,
  // the same row value can appear (that's the whole reason tier is a tie-break).
  function generateRows(count: number, seed: number): Row[] {
    const rows: Row[] = []
    const usedChained = new Set<number>()
    const usedLogged = new Set<number>()
    for (let i = 0; i < count; i++) {
      const v = (seed * 31 + i * 17) % 1000
      const tier: 'chained' | 'logged' = v % 3 === 0 ? 'logged' : 'chained'
      const used = tier === 'chained' ? usedChained : usedLogged
      let row = (v % 300) + 1
      while (used.has(row)) row++
      used.add(row)
      rows.push({
        id: `evt-${seed}-${i}`,
        ts: 1000 + (v % 50),  // many timestamp collisions
        row,
        tier
      })
    }
    return rows
  }

  const seeds = [1, 7, 42, 99, 256]
  const sizes = [50, 100, 200]
  const pageSizes = [1, 3, 17, 50, 200]

  for (const seed of seeds) {
    for (const size of sizes) {
      const allRows = generateRows(size, seed)
      const canonical = canonicalSort(allRows)

      for (const ps of pageSizes) {
        const label = `seed=${seed} size=${size} pageSize=${ps}`

        it(`concat(pages) = canonical set [${label}]`, () => {
          const pages = paginate(allRows, ps)
          const all = pages.flat()
          expect(all.map(r => r.id)).toEqual(canonical.map(r => r.id))
        })

        it(`pages are disjoint [${label}]`, () => {
          const pages = paginate(allRows, ps)
          const seen = new Set<string>()
          for (const page of pages) {
            for (const r of page) {
              expect(seen.has(r.id)).toBe(false)
              seen.add(r.id)
            }
          }
        })

        it(`each page maintains canonical ordering [${label}]`, () => {
          const pages = paginate(allRows, ps)
          for (const page of pages) {
            for (let i = 1; i < page.length; i++) {
              const a = page[i - 1], b = page[i]
              const cmp = (b.ts - a.ts) || (b.row - a.row) || (TIER_RANK[b.tier] - TIER_RANK[a.tier])
              expect(cmp).toBeLessThanOrEqual(0)
            }
          }
        })
      }
    }
  }

  // Edge case: all rows have identical (ts, row) but different tier
  it('tie-break by tier works at page boundary', () => {
    const rows: Row[] = [
      { id: 'a', ts: 1000, row: 1, tier: 'chained' },
      { id: 'b', ts: 1000, row: 1, tier: 'logged' }
    ]
    const pages = paginate(rows, 1)
    expect(pages).toHaveLength(2)
    expect(pages[0][0].id).toBe('a')  // chained first (rank=1)
    expect(pages[1][0].id).toBe('b')  // logged second (rank=0)
  })

  // Edge case: many identical timestamps
  it('handles 100 rows with same timestamp', () => {
    const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({
      id: `same-ts-${i}`,
      ts: 5000,
      row: 100 - i,
      tier: (i % 2 === 0 ? 'chained' : 'logged') as 'chained' | 'logged'
    }))
    const pages = paginate(rows, 7)
    const all = pages.flat()
    expect(all).toHaveLength(100)
    expect(new Set(all.map(r => r.id)).size).toBe(100)
  })
})
