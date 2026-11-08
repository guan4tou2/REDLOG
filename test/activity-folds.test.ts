// Stitch audit 2026-11-08: RedLog's own state changes headed the activity log.
// Runs of them fold into one row; findings and searched-for rows never do.
import { describe, expect, it } from 'vitest'
import { foldSystemRuns, SYSTEM_FOLD_MIN } from '../src/renderer/src/lib/activityFolds'
import type { ActivitySummary } from '../src/core/activity-contract'

const item = (id: string, agentType: string, subtype = 'x'): ActivitySummary =>
  ({ id, anchor: { id, agentType, data: { subtype } } } as unknown as ActivitySummary)
const sys = (id: string, subtype = 'ip_verdict'): ActivitySummary => item(id, 'system', subtype)
const shape = (segs: ReturnType<typeof foldSystemRuns>): string[] =>
  segs.map((s) => s.kind === 'item' ? s.item.id : `fold(${s.items.map((i) => i.id).join(',')})@${s.at}`)

describe('foldSystemRuns', () => {
  it('folds a run of system rows and keeps the rest in order', () => {
    const items = [sys('a'), sys('b'), sys('c'), item('d', 'shell'), sys('e')]
    expect(shape(foldSystemRuns(items, true))).toEqual(['fold(a,b,c)@0', 'd', 'e'])
  })

  it('leaves a run shorter than the minimum as rows', () => {
    expect(SYSTEM_FOLD_MIN).toBe(3)
    expect(shape(foldSystemRuns([sys('a'), sys('b'), item('c', 'shell')], true))).toEqual(['a', 'b', 'c'])
  })

  it('never folds a scope observation, which breaks the run', () => {
    const items = [sys('a'), sys('b'), sys('v', 'scope_violation'), sys('c'), sys('d'), sys('e')]
    expect(shape(foldSystemRuns(items, true))).toEqual(['a', 'b', 'v', 'fold(c,d,e)@3'])
  })

  it('only folds the system agent type, not other capture of the system', () => {
    const items = [item('p', 'process'), item('f', 'file'), item('c', 'clipboard')]
    expect(shape(foldSystemRuns(items, true))).toEqual(['p', 'f', 'c'])
  })

  it('folds nothing while a query is active', () => {
    expect(shape(foldSystemRuns([sys('a'), sys('b'), sys('c')], false))).toEqual(['a', 'b', 'c'])
  })
})
