import { useSyncExternalStore } from 'react'

// Persistent faults, in two tiers (docs/UIUX-STANDARD.md §9).
//
// A toast is the wrong shape for a condition. Toasts are for events — "saved",
// "export failed" — and they leave. A capture source that went dark, a chain
// that will not verify, an anchor that never landed: those are *states*, true
// until someone fixes them, and firing a toast every thirty seconds about one
// is both nagging and useless, because the operator dismisses it and then has
// no way to ask what is currently wrong.
//
// So conditions live here and render as two counters pinned to the status bar,
// and the split is not by severity but by consequence:
//
//   attention  the evidence is affected — capture is dark, the chain broke, a
//              write failed, a file referenced by an event is gone. Cannot be
//              dismissed; it clears when the condition clears, and nothing
//              else. Red.
//   pending    everything else worth surfacing and nothing worth interrupting
//              for. Grey. An undeclared scope is the one that raises it: a
//              project minutes old has not named its targets yet and nothing
//              is wrong with it. The dismiss controls §9 describes are still
//              not built, and this source does not want them — it clears the
//              moment a target is declared. Dismissing one would write no
//              audit event anyway, because a person deciding not to look at
//              something is not a fact about the engagement.
//
// The store is deliberately outside React: capture health polls from an
// effect, chain verification resolves from a dialog, and a producer should not
// have to be a component to report that something is wrong.

export type IssueTier = 'attention' | 'pending'

/** The act that answers a condition, where one act answers it.
 *
 *  A name, not a function. A producer here is a thirty-second poll that runs
 *  whether or not anything is mounted, and a closure in the store would make
 *  it hold a `t` and a component's state for as long as the condition lasts —
 *  while `snapshotIssues` caches by title, so the UI could keep showing a
 *  closure from an earlier raise. The renderer owns the handler and the
 *  label; the store only says which one applies. */
export type IssueFix = 'anchor-now' | 'verify-chain' | 'recheck-scope'

export interface Issue {
  /** Stable per condition — re-raising the same id updates rather than piles up. */
  id: string
  tier: IssueTier
  title: string
  /** What it means for the record, in one line. */
  detail?: string
  /** Where to go to deal with it. */
  view?: string
  /** Offered beside it, when one act answers it without going anywhere. */
  fix?: IssueFix
  since: number
}

const issues = new Map<string, Issue>()
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

/** Assert that a condition is currently true. Idempotent per `id`. */
export function raiseIssue(issue: Omit<Issue, 'since'> & { since?: number }): void {
  const existing = issues.get(issue.id)
  // Keep the original `since` so "how long has this been broken" survives a
  // re-raise from the next poll.
  issues.set(issue.id, { ...issue, since: existing?.since ?? issue.since ?? Date.now() })
  emit()
}

/** Assert that a condition is no longer true. */
export function clearIssue(id: string): void {
  if (issues.delete(id)) emit()
}

function snapshot(): Issue[] {
  return [...issues.values()]
    .sort((a, b) => (a.tier === b.tier ? a.since - b.since : a.tier === 'attention' ? -1 : 1))
}

let cached: Issue[] = []
let cacheKey = ''
/** The list as the UI sees it, attention first. Also
 *  the seam tests read, so they do not have to mount React to check a policy. */
export function snapshotIssues(): Issue[] {
  const next = snapshot()
  // `useSyncExternalStore` compares by identity and will loop forever on a
  // fresh array every call, so only hand back a new one when it differs.
  const key = next.map((i) => `${i.id}:${i.tier}:${i.title}:${i.fix ?? ''}`).join('|')
  if (key !== cacheKey) { cacheKey = key; cached = next }
  return cached
}

export function useIssues(): Issue[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    snapshotIssues,
    snapshotIssues
  )
}

/** Test seam — the store is module state and would otherwise leak between cases. */
export function _resetIssues(): void {
  issues.clear()
  cacheKey = ''
  cached = []
  emit()
}
