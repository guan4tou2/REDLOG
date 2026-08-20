import { describe, it, expect, beforeEach } from 'vitest'
import {
  raiseIssue, clearIssue, dismissIssue, snapshotIssues, _resetIssues
} from '../src/renderer/src/lib/issues'

// The store behind the status bar's two counters (UIUX-STANDARD §9). The rule
// most worth pinning is a policy rather than a mechanism: an attention-tier
// issue cannot be waved away. Everything about "the evidence is intact" stops
// meaning anything the moment that becomes negotiable.

beforeEach(() => { _resetIssues() })

describe('issue store', () => {
  it('keeps one entry per condition however often it is re-raised', () => {
    // Capture health polls every 30s and re-raises each time it is unhappy.
    for (let i = 0; i < 20; i++) {
      raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture is dark' })
    }
    expect(snapshotIssues()).toHaveLength(1)
  })

  it('remembers how long a condition has been true across re-raises', () => {
    raiseIssue({ id: 'chain', tier: 'attention', title: 'Chain broken', since: 1000 })
    raiseIssue({ id: 'chain', tier: 'attention', title: 'Chain broken', since: 9999 })
    expect(snapshotIssues()[0].since).toBe(1000)
  })

  it('refuses to dismiss an attention-tier issue', () => {
    raiseIssue({ id: 'chain', tier: 'attention', title: 'Chain broken' })
    dismissIssue('chain')
    expect(snapshotIssues().map((x) => x.id)).toEqual(['chain'])
  })

  it('dismisses a pending issue', () => {
    raiseIssue({ id: 'update', tier: 'pending', title: 'Update available' })
    dismissIssue('update')
    expect(snapshotIssues()).toEqual([])
  })

  it('un-dismisses when the condition goes away and comes back', () => {
    // Otherwise a dismissal is permanent for the session, and a fault that
    // recurs after being waved away never shows again.
    raiseIssue({ id: 'update', tier: 'pending', title: 'Update available' })
    dismissIssue('update')
    clearIssue('update')
    raiseIssue({ id: 'update', tier: 'pending', title: 'Update available' })
    expect(snapshotIssues().map((x) => x.id)).toEqual(['update'])
  })

  it('sorts attention ahead of pending, oldest first inside a tier', () => {
    raiseIssue({ id: 'p1', tier: 'pending', title: 'p1', since: 10 })
    raiseIssue({ id: 'a2', tier: 'attention', title: 'a2', since: 200 })
    raiseIssue({ id: 'a1', tier: 'attention', title: 'a1', since: 100 })
    expect(snapshotIssues().map((x) => x.id)).toEqual(['a1', 'a2', 'p1'])
  })

  it('hands back the same array until something actually changes', () => {
    // useSyncExternalStore compares snapshots by identity and loops forever
    // on a fresh array every read.
    raiseIssue({ id: 'a', tier: 'attention', title: 'a' })
    expect(snapshotIssues()).toBe(snapshotIssues())
    raiseIssue({ id: 'b', tier: 'pending', title: 'b' })
    expect(snapshotIssues().map((x) => x.id)).toEqual(['a', 'b'])
  })
})
