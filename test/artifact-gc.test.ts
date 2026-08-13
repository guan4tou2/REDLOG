import { describe, it, expect } from 'vitest'
import { planArtifactRotation, type ArtifactBody } from '../src/core/artifact-gc'

// Artifact rotation planner (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C). The pure
// decision behind io/ lifecycle: what to compress, what to delete. The tests
// pin the three properties the spec is emphatic about — refcount gating,
// age-or-size triggers, and scope-as-pin eviction order (A5).

const body = (over: Partial<ArtifactBody> & { sha: string }): ArtifactBody => ({
  bytes: 1000, compressed: false, ageDays: 0, pruneDays: 0, pinned: true, pinScore: 60, ...over
})

describe('age prune (refcount-gated)', () => {
  it('prunes a body whose newest referencing event is past its window', () => {
    const plan = planArtifactRotation([body({ sha: 'a', ageDays: 40, pruneDays: 30 })], { warmDays: 0, maxBytes: 0 })
    expect(plan.toPrune).toEqual(['a'])
  })

  it('keeps a body still referenced by a fresh event (ageDays = newest ref)', () => {
    // referenced by an old AND a fresh event → ageDays is the fresh one → keep
    const plan = planArtifactRotation([body({ sha: 'a', ageDays: 2, pruneDays: 30 })], { warmDays: 0, maxBytes: 0 })
    expect(plan.toPrune).toEqual([])
  })

  it('never age-prunes when the window is 0 (keep forever)', () => {
    const plan = planArtifactRotation([body({ sha: 'a', ageDays: 9999, pruneDays: 0 })], { warmDays: 0, maxBytes: 0 })
    expect(plan.toPrune).toEqual([])
  })
})

describe('warm compress', () => {
  it('compresses survivors older than warmDays that are not already warm', () => {
    const plan = planArtifactRotation([
      body({ sha: 'old', ageDays: 10 }),
      body({ sha: 'fresh', ageDays: 1 }),
      body({ sha: 'already', ageDays: 10, compressed: true })
    ], { warmDays: 7, maxBytes: 0 })
    expect(plan.toCompress).toEqual(['old'])
  })

  it('does not compress a body it is about to prune', () => {
    const plan = planArtifactRotation(
      [body({ sha: 'a', ageDays: 40, pruneDays: 30 })],
      { warmDays: 7, maxBytes: 0 }
    )
    expect(plan.toPrune).toEqual(['a'])
    expect(plan.toCompress).toEqual([])
  })
})

describe('size prune (scope as pin, A5)', () => {
  it('evicts unpinned bodies first when over the cap, keeping pinned', () => {
    // cap 2500; four 1000-byte bodies = 4000 over. Two unpinned, two pinned.
    const plan = planArtifactRotation([
      body({ sha: 'pin1', pinned: true, pinScore: 60 }),
      body({ sha: 'pin2', pinned: true, pinScore: 80 }),
      body({ sha: 'unpin-out', pinned: false, pinScore: 10 }),
      body({ sha: 'unpin-unknown', pinned: false, pinScore: 30 })
    ], { warmDays: 0, maxBytes: 2500 })
    // must evict 1500 worth → both unpinned (2000), lowest pinScore first
    expect(plan.toPrune.sort()).toEqual(['unpin-out', 'unpin-unknown'])
  })

  it('evicts by ascending pin score (out_of_scope before unknown)', () => {
    // cap lets exactly one 1000-body survive of the two unpinned → drop the lower score
    const plan = planArtifactRotation([
      body({ sha: 'keepPinned', pinned: true, bytes: 1000 }),
      body({ sha: 'out', pinned: false, pinScore: 10, bytes: 1000 }),
      body({ sha: 'unknown', pinned: false, pinScore: 30, bytes: 1000 })
    ], { warmDays: 0, maxBytes: 2500 })   // 3000 total, cap 2500 → drop one
    expect(plan.toPrune).toEqual(['out'])
  })

  it('never size-evicts a pinned body even if that leaves the store over cap', () => {
    const plan = planArtifactRotation([
      body({ sha: 'p1', pinned: true, bytes: 5000 }),
      body({ sha: 'p2', pinned: true, bytes: 5000 })
    ], { warmDays: 0, maxBytes: 1000 })
    expect(plan.toPrune).toEqual([])   // in-scope evidence kept even under pressure
  })

  it('leaves the store alone when under the cap', () => {
    const plan = planArtifactRotation([body({ sha: 'a', bytes: 100, pinned: false, pinScore: 0 })], { warmDays: 0, maxBytes: 10_000 })
    expect(plan.toPrune).toEqual([])
  })
})

describe('combined', () => {
  it('age-prunes, compresses, and size-evicts in one pass', () => {
    const plan = planArtifactRotation([
      body({ sha: 'expired', ageDays: 99, pruneDays: 30, pinned: false, pinScore: 10 }),
      body({ sha: 'warmable', ageDays: 10, pruneDays: 0, pinned: true, pinScore: 60, bytes: 1000 }),
      body({ sha: 'evictme', ageDays: 5, pruneDays: 0, pinned: false, pinScore: 10, bytes: 4000 }),
      body({ sha: 'pinned', ageDays: 5, pruneDays: 0, pinned: true, pinScore: 80, bytes: 1000 })
    ], { warmDays: 7, maxBytes: 1500 })
    expect(plan.toPrune).toContain('expired')       // age
    expect(plan.toPrune).toContain('evictme')       // size (unpinned)
    expect(plan.toPrune).not.toContain('pinned')    // pinned survives
    expect(plan.toCompress).toEqual(['warmable'])   // old survivor compresses
  })
})
