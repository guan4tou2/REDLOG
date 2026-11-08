// Runs of RedLog's own state changes (proxy started, IP verdict, air-gap…)
// fold into one row in the activity log. The Stitch audit (2026-11-08) found
// six of them heading the log above the first thing the operator did; Stitch
// 04's operation log shows operations only. Folded, not hidden: one click
// opens the run.
import type { ActivitySummary } from '../../../core/activity-contract'
import { SCOPE_VIOLATION_SUBTYPE } from '../../../core/scope-vocabulary'

/** Shortest run worth folding; one or two rows cost less than the fold row. */
export const SYSTEM_FOLD_MIN = 3

export type ActivitySegment =
  | { kind: 'item'; item: ActivitySummary; at: number }
  | { kind: 'fold'; key: string; items: ActivitySummary[]; at: number }

/** A RedLog state change. Scope observations are findings, not plumbing. */
export function isFoldableSystem(item: ActivitySummary): boolean {
  return item.anchor.agentType === 'system' && item.anchor.data?.subtype !== SCOPE_VIOLATION_SUBTYPE
}

/** The list as rows and folds, in order; `at` is each segment's first index. */
export function foldSystemRuns(items: readonly ActivitySummary[], enabled: boolean): ActivitySegment[] {
  const out: ActivitySegment[] = []
  let i = 0
  while (i < items.length) {
    if (enabled && isFoldableSystem(items[i])) {
      let j = i
      while (j < items.length && isFoldableSystem(items[j])) j++
      if (j - i >= SYSTEM_FOLD_MIN) {
        out.push({ kind: 'fold', key: items[i].id, items: items.slice(i, j), at: i })
        i = j
        continue
      }
    }
    out.push({ kind: 'item', item: items[i], at: i })
    i++
  }
  return out
}
