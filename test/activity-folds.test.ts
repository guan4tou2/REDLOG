// Stitch audit 2026-11-08: RedLog's own state changes headed the activity log.
// Runs of them fold into one row; findings and searched-for rows never do.
import { describe, expect, it } from 'vitest'
import { foldSystemRuns, isFoldableSystem, SYSTEM_FOLD_MIN } from '../src/renderer/src/lib/activityFolds'
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

  // Real-app audit: with no scope configured, every observed host files one
  // 範圍未判定 row, and the activity log was a column of them. Unjudged is
  // not a finding — nothing is outside an undrawn boundary — so it folds.
  it('folds unjudged scope rows (no scope configured), and keeps each one reachable', () => {
    const unjudged = (id: string): ActivitySummary =>
      ({ id, anchor: { id, agentType: 'system', data: { subtype: 'scope_violation', distance: 'in_scope', authority: 'unknown' } } } as unknown as ActivitySummary)
    const judged = (id: string): ActivitySummary =>
      ({ id, anchor: { id, agentType: 'system', data: { subtype: 'scope_violation', distance: 'in_scope', authority: 'fact' } } } as unknown as ActivitySummary)
    const items = [item('cmd', 'shell'), unjudged('u1'), unjudged('u2'), unjudged('u3'), unjudged('u4'), item('cmd2', 'shell'), judged('j1'), judged('j2'), judged('j3')]
    expect(shape(foldSystemRuns(items, true))).toEqual(['cmd', 'fold(u1,u2,u3,u4)@1', 'cmd2', 'fold(j1,j2,j3)@6'])
  })

  // Decision 2026-11-15 §1 item 6: every in-scope action writes a clean
  // verdict, the positive record that scope was observed. It is kept and
  // chained, and folds like the rest of RedLog's own rows. Anything that is not
  // clean is an observation the operator has to see, and never folds.
  const verdict = (id: string, distance: string, severity: string): ActivitySummary =>
    ({ id, anchor: { id, agentType: 'system', data: { subtype: 'scope_violation', distance, authority: 'fact', severity, action: 'nmap 10.20.0.5' } } } as unknown as ActivitySummary)
  const clean = (id: string): ActivitySummary => verdict(id, 'in_scope', 'clean')

  it('folds judged in-scope verdicts', () => {
    expect(isFoldableSystem(clean('c'))).toBe(true)
  })

  for (const [distance, severity] of [['excluded', 'critical'], ['adjacent_subnet', 'warning'], ['adjacent_domain', 'warning'], ['unrelated', 'notice']]) {
    it(`never folds a ${distance} observation, with or without a query`, () => {
      const v = verdict('v', distance, severity)
      expect(isFoldableSystem(v)).toBe(false)
      const items = [clean('a'), clean('b'), v, clean('c'), clean('d'), clean('e')]
      expect(shape(foldSystemRuns(items, true))).toEqual(['a', 'b', 'v', 'fold(c,d,e)@3'])
      expect(shape(foldSystemRuns(items, false))).toEqual(['a', 'b', 'v', 'fold(c,d,e)@3'])
      expect(shape(foldSystemRuns([v, v, v].map((x, i) => ({ ...x, id: `v${i}` })), false))).toEqual(['v0', 'v1', 'v2'])
    })
  }

  it('folds in-scope verdicts while a query is active, and nothing else of the system', () => {
    // A search for `nmap` matches the verdict too: its `action` repeats the command.
    const items = [item('cmd', 'shell'), clean('a'), clean('b'), clean('c'), sys('p1'), sys('p2'), sys('p3')]
    expect(shape(foldSystemRuns(items, false))).toEqual(['cmd', 'fold(a,b,c)@1', 'p1', 'p2', 'p3'])
  })

  it('only folds the system agent type, not other capture of the system', () => {
    const items = [item('p', 'process'), item('f', 'file'), item('c', 'cleanup')]
    expect(shape(foldSystemRuns(items, true))).toEqual(['p', 'f', 'c'])
  })

  it('folds nothing while a query is active', () => {
    expect(shape(foldSystemRuns([sys('a'), sys('b'), sys('c')], false))).toEqual(['a', 'b', 'c'])
  })
})
