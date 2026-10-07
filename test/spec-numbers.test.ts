import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM helper shared with scripts/verify-specs.mjs
import { numberCollisions, specNumber } from '../scripts/spec-numbers.mjs'

// Two branches that each start "the next spec" pick the same number, and git
// merges both without a conflict: the directories differ by their slug. The
// collision only shows up afterwards, in a tree with two specs numbered 048,
// by which point the number is in the spec heading, its tasks, its plan, its
// verification record and every commit that cited it.
//
// `verify:specs` runs this against the working tree and against origin/main.
// Here it runs against the cases a working tree does not have on demand.

describe('spec numbering', () => {
  it('reads the NNN prefix, and ignores a directory without one', () => {
    expect(specNumber('048-pane-target-derivation')).toBe('048')
    expect(specNumber('notes')).toBeNull()
  })

  it('passes a tree where every number is used once', () => {
    expect(numberCollisions(['046-a', '047-b', '048-c'], ['046-a', '047-b'])).toEqual([])
  })

  it('catches two specs holding the same number in one tree', () => {
    const [failure, ...rest] = numberCollisions(['048-one', '048-two', '049-ok'], [])
    expect(rest).toEqual([])
    expect(failure).toContain('048')
    expect(failure).toContain('048-one')
    expect(failure).toContain('048-two')
  })

  it('catches a number another branch already landed on main', () => {
    // The real shape: ours is unpushed, theirs is already upstream.
    const [failure, ...rest] = numberCollisions(['048-mine'], ['047-x', '048-theirs'])
    expect(rest).toEqual([])
    expect(failure).toContain('048-mine')
    expect(failure).toContain('048-theirs')
    expect(failure, 'the gate has to say what to do, not just that it is wrong').toMatch(/renumber/i)
  })

  it('says nothing about a spec that is simply already on main', () => {
    expect(numberCollisions(['048-mine'], ['048-mine'])).toEqual([])
  })

  it('still checks the local half when origin/main is out of reach', () => {
    // A shallow CI checkout or a clone with no remote. A gate that fails
    // because a ref is missing is a gate someone switches off.
    expect(numberCollisions(['048-one', '048-two'], null)).toHaveLength(1)
    expect(numberCollisions(['048-one', '049-two'], null)).toEqual([])
  })
})
