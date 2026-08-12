import { describe, it, expect } from 'vitest'
import { groupByTarget } from '../src/renderer/src/lib/targetGrouping'
import type { EventLike } from '../src/renderer/src/lib/targetGrouping'

// DESIGN-PRINCIPLES §8/§9 reorganise the timeline around a target axis (source-type
// demotes to a filter, TargetView folds in as the target grouping). This seam is the
// data source for that axis: it groups events by targetId. §12 sets the honesty rule —
// conservative attribution, never guess: any event whose target is null/undefined/''
// goes into ONE explicit "untargeted" bucket (target: null), never orphaned, never
// guessed onto some other target. That bucket always sorts LAST so it reads as the
// residual pile, not as another real target.

const E = (id: string, timestamp: number, targetId?: string | null): EventLike => ({
  id,
  timestamp,
  targetId
})

describe('groupByTarget', () => {
  it('empty input → []', () => {
    expect(groupByTarget([])).toEqual([])
  })

  it('all events share one target → a single group', () => {
    const result = groupByTarget([E('a', 10, 'host1'), E('b', 20, 'host1')])
    expect(result).toEqual([
      { target: 'host1', eventIds: ['a', 'b'], firstTs: 10, lastTs: 20 }
    ])
  })

  it('all events targeted → no untargeted group appears', () => {
    const result = groupByTarget([E('a', 10, 'host1'), E('b', 20, 'host2')])
    expect(result.some((g) => g.target === null)).toBe(false)
  })

  it('all events untargeted → exactly one target:null group', () => {
    const result = groupByTarget([E('a', 10), E('b', 20, null), E('c', 30, '')])
    expect(result).toEqual([
      { target: null, eventIds: ['a', 'b', 'c'], firstTs: 10, lastTs: 30 }
    ])
  })

  it('multiple targets are ordered by first-event ts (ascending)', () => {
    // host2 fires first (ts 5), host1 later (ts 10) → host2 must come first.
    const result = groupByTarget([E('a', 10, 'host1'), E('b', 5, 'host2'), E('c', 30, 'host1')])
    expect(result.map((g) => g.target)).toEqual(['host2', 'host1'])
  })

  it('untargeted bucket always sorts last, even when its first event is earliest', () => {
    // The untargeted event (ts 1) is the earliest of all, yet the bucket must still
    // be last: it is the residual pile, never a real target position.
    const result = groupByTarget([E('u', 1), E('a', 10, 'host1'), E('b', 20, 'host2')])
    expect(result.map((g) => g.target)).toEqual(['host1', 'host2', null])
  })

  it('mixes targeted and untargeted events, untargeted collected into the one bucket', () => {
    const result = groupByTarget([
      E('a', 10, 'host1'),
      E('u1', 15),
      E('b', 20, 'host2'),
      E('u2', 25, ''),
      E('c', 30, 'host1')
    ])
    expect(result).toEqual([
      { target: 'host1', eventIds: ['a', 'c'], firstTs: 10, lastTs: 30 },
      { target: 'host2', eventIds: ['b'], firstTs: 20, lastTs: 20 },
      { target: null, eventIds: ['u1', 'u2'], firstTs: 15, lastTs: 25 }
    ])
  })

  it('empty-string target counts as untargeted, not as a distinct target', () => {
    const result = groupByTarget([E('a', 10, ''), E('b', 20, 'host1')])
    expect(result.map((g) => g.target)).toEqual(['host1', null])
    expect(result.find((g) => g.target === null)?.eventIds).toEqual(['a'])
  })

  it('unsorted input: both group order and within-group order come out sorted', () => {
    const result = groupByTarget([
      E('c', 30, 'host1'),
      E('b', 20, 'host2'),
      E('a', 10, 'host1')
    ])
    // host1 first (firstTs 10) then host2 (firstTs 20); host1's ids in ts order.
    expect(result.map((g) => g.target)).toEqual(['host1', 'host2'])
    expect(result[0].eventIds).toEqual(['a', 'c'])
  })

  it('same target scattered across time stays one group (not split by gaps)', () => {
    const result = groupByTarget([
      E('a', 10, 'host1'),
      E('b', 20, 'host2'),
      E('c', 100, 'host1')
    ])
    const host1 = result.find((g) => g.target === 'host1')
    expect(host1?.eventIds).toEqual(['a', 'c'])
    expect(host1).toEqual({ target: 'host1', eventIds: ['a', 'c'], firstTs: 10, lastTs: 100 })
  })

  it('firstTs/lastTs bound the group even for unsorted input', () => {
    const result = groupByTarget([E('c', 30, 'h'), E('a', 5, 'h'), E('b', 50, 'h')])
    expect(result[0].firstTs).toBe(5)
    expect(result[0].lastTs).toBe(50)
    expect(result[0].eventIds).toEqual(['a', 'c', 'b'])
  })
})
