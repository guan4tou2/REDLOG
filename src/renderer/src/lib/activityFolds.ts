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

/** The row's data when RedLog wrote it about itself (agent type `system`). */
const systemData = (item: ActivitySummary): Record<string, unknown> | undefined =>
  item.anchor.agentType === 'system' ? item.anchor.data ?? {} : undefined

/** A clean scope verdict: every in-scope action writes one, the positive
 *  record that scope was observed (`ScopePolicy` always emits `in_scope`). It
 *  stays in the chain and in every count; here it is RedLog's own bookkeeping
 *  beside the action it judged, and its `action` repeats that action's text,
 *  so a search for the command matched it too (decision 2026-11-15 §1 item 6).
 *  With no scope configured the same row says 範圍未判定 (`authority:
 *  'unknown'`). Any other distance is an observation and never folds. */
function isScopeAdherence(item: ActivitySummary): boolean {
  const d = systemData(item)
  return d?.subtype === SCOPE_VIOLATION_SUBTYPE && d.distance === 'in_scope'
}

/** A RedLog state change. Scope observations are findings, not plumbing;
 *  a clean verdict is not an observation. */
export function isFoldableSystem(item: ActivitySummary): boolean {
  const d = systemData(item)
  return !!d && (d.subtype !== SCOPE_VIOLATION_SUBTYPE || isScopeAdherence(item))
}

/** The list as rows and folds, in order; `at` is each segment's first index.
 *  While a query is active (`all` false) the operator asked for the rows it
 *  matched, so only clean verdicts fold. */
export function foldSystemRuns(items: readonly ActivitySummary[], all: boolean): ActivitySegment[] {
  const foldable = all ? isFoldableSystem : isScopeAdherence
  const out: ActivitySegment[] = []
  let i = 0
  while (i < items.length) {
    if (foldable(items[i])) {
      let j = i
      while (j < items.length && foldable(items[j])) j++
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
