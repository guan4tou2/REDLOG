import { describe, it, expect, afterEach } from 'vitest'
import { raiseIssue, clearIssue, dismissIssue, dismissAllPending, snapshotIssues } from '../src/renderer/src/lib/issues'

// The issue store is a module singleton, so each test cleans up the ids it
// raised (clearIssue also drops them from the dismissed set).
const raised: string[] = []
const raise = (id: string, tier: 'attention' | 'pending'): void => {
  raiseIssue({ id, tier, title: id }); raised.push(id)
}
afterEach(() => { for (const id of raised) clearIssue(id); raised.length = 0 })

describe('issues — 全部忽略 / dismiss (design 3c / §9)', () => {
  it('dismissAllPending waves away pending and never attention', () => {
    raise('p1', 'pending'); raise('p2', 'pending'); raise('a1', 'attention')
    expect(dismissAllPending()).toBe(2)
    const ids = snapshotIssues().map((i) => i.id)
    expect(ids).toContain('a1')          // evidence-affecting: never dismissable
    expect(ids).not.toContain('p1')
    expect(ids).not.toContain('p2')
  })

  it('returns 0 when nothing pending is showing (idempotent)', () => {
    raise('a2', 'attention')
    expect(dismissAllPending()).toBe(0)
    // a second call after real dismissals still returns 0
    raise('p3', 'pending')
    expect(dismissAllPending()).toBe(1)
    expect(dismissAllPending()).toBe(0)
  })

  it('single dismiss also refuses attention-tier', () => {
    raise('a3', 'attention')
    dismissIssue('a3')
    expect(snapshotIssues().map((i) => i.id)).toContain('a3')
  })

  it('clearing a dismissed issue lets the same id show again if re-raised', () => {
    raise('p4', 'pending')
    dismissIssue('p4')
    expect(snapshotIssues().map((i) => i.id)).not.toContain('p4')
    clearIssue('p4')
    raiseIssue({ id: 'p4', tier: 'pending', title: 'p4' })  // re-raise; already in `raised`
    expect(snapshotIssues().map((i) => i.id)).toContain('p4')
  })
})
