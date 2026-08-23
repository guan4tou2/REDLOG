import { describe, it, expect } from 'vitest'
import { planEviction, type BodyEntry } from '../src/core/body-eviction'

// docs/DESIGN-core-and-capture.md §6. This is a policy for deleting captured
// content under disk pressure, in a tool whose whole point is not losing it —
// so the tests are mostly about what it must REFUSE to do.

const e = (o: Partial<BodyEntry> & { file: string }): BodyEntry => ({
  sizeBytes: 1000, mtimeMs: 1000, pinned: false, ...o
})

describe('planning body eviction under a size budget', () => {
  it('evicts nothing when the store is under budget', () => {
    const plan = planEviction([e({ file: 'a', sizeBytes: 100 })], 1000)
    expect(plan.evict).toEqual([])
    expect(plan.freedBytes).toBe(0)
  })

  it('evicts nothing when no budget is set — unbounded is the default', () => {
    // A project that never opts in must behave exactly as before this existed.
    const plan = planEviction([e({ file: 'a', sizeBytes: 1e9 })], 0)
    expect(plan.evict).toEqual([])
  })

  it('evicts just enough to get under budget, not everything', () => {
    const plan = planEviction([
      e({ file: 'a', sizeBytes: 500, mtimeMs: 1 }),
      e({ file: 'b', sizeBytes: 500, mtimeMs: 2 }),
      e({ file: 'c', sizeBytes: 500, mtimeMs: 3 })
    ], 1000)
    // total 1500, budget 1000 → drop one (the coldest).
    expect(plan.evict).toEqual(['a'])
    expect(plan.freedBytes).toBe(500)
  })

  it('never evicts a pinned body, even to reach budget', () => {
    // Scope is the pin. The in-scope capture is what the operator is here for.
    const plan = planEviction([
      e({ file: 'pinned', sizeBytes: 900, mtimeMs: 1, pinned: true }),
      e({ file: 'cold', sizeBytes: 900, mtimeMs: 2 })
    ], 1000)
    expect(plan.evict).toEqual(['cold'])
    expect(plan.evict).not.toContain('pinned')
  })

  it('reports a shortfall rather than touching pinned content', () => {
    // If the pinned set alone is over budget, a full disk is a problem to
    // surface — not a licence to delete evidence.
    const plan = planEviction([
      e({ file: 'p1', sizeBytes: 800, pinned: true }),
      e({ file: 'p2', sizeBytes: 800, pinned: true }),
      e({ file: 'cold', sizeBytes: 400, mtimeMs: 1 })
    ], 1000)
    expect(plan.evict).toEqual(['cold'])
    // 2000 total − 400 freed = 1600 remaining, 600 over the 1000 budget, all pinned.
    expect(plan.shortfallBytes).toBe(600)
  })

  it('takes the coldest first, largest as the tiebreak', () => {
    const plan = planEviction([
      e({ file: 'newer-big', sizeBytes: 900, mtimeMs: 30 }),
      e({ file: 'older-small', sizeBytes: 100, mtimeMs: 10 }),
      e({ file: 'older-big', sizeBytes: 300, mtimeMs: 10 })
    ], 900)
    // total 1300, budget 900 → need to free ≥400. Coldest mtime is 10; among
    // those the bigger goes first (older-big 300), then older-small (100) = 400.
    expect(plan.evict).toEqual(['older-big', 'older-small'])
    expect(plan.freedBytes).toBe(400)
  })

  it('stops the moment it is under budget', () => {
    const plan = planEviction([
      e({ file: 'a', sizeBytes: 600, mtimeMs: 1 }),
      e({ file: 'b', sizeBytes: 600, mtimeMs: 2 }),
      e({ file: 'c', sizeBytes: 600, mtimeMs: 3 })
    ], 1000)
    // total 1800 → drop a (1200), still over; drop b (600), under. c survives.
    expect(plan.evict).toEqual(['a', 'b'])
    expect(plan.freedBytes).toBe(1200)
  })

  it('reports the total for the audit trail', () => {
    const plan = planEviction([e({ file: 'a', sizeBytes: 100 }), e({ file: 'b', sizeBytes: 250 })], 0)
    expect(plan.totalBytes).toBe(350)
  })

  it('handles an empty store', () => {
    expect(planEviction([], 1000)).toEqual({ evict: [], freedBytes: 0, shortfallBytes: 0, totalBytes: 0 })
  })

  it('does not evict when exactly at budget', () => {
    // Boundary: at budget is under pressure but not over it.
    const plan = planEviction([e({ file: 'a', sizeBytes: 1000 })], 1000)
    expect(plan.evict).toEqual([])
  })
})
