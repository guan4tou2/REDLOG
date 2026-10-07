import { useState } from 'react'
import { SectionLabel } from './SectionLabel'
import { Button } from './Button'
import { useIssues, type Issue, type IssueFix } from '../lib/issues'
import { anchorNowWithFeedback, verifyChainWithFeedback } from '../lib/chainActions'
import { formatFreshness } from '../lib/time'
import { useTick } from '../lib/useTick'
import { useI18n } from '../i18n'

// What is currently wrong, where the operator already is.
//
// The issue store has had the right shape since §9 — conditions, two tiers,
// each carrying where to deal with it — and exactly one surface: two counters
// pinned to the status bar, 8px tall, at the bottom of the window. Everything
// a condition knows about itself (what it means for the record, how long it
// has been true, what would answer it) was in a `title` attribute, and the
// only way to act was to be taken somewhere else.
//
// So the dashboard reads the same store. Not a second copy of the state: the
// counters stay, because they are what an operator on the Timeline at 2am
// still has in front of them, and this is what the counter is a count of.
//
// `fix` is the part the artifact that prompted this got right and the app did
// not: when one act answers the condition, the act belongs beside it. An
// anchor that failed is answered by submitting again — one call, from here,
// without walking to Settings ▸ Integrity to press a button that was already
// going to be pressed.

const FIX_LABEL: Record<IssueFix, string> = {
  'anchor-now': 'issues.fix.anchorNow',
  'verify-chain': 'issues.fix.verifyChain'
}

type T = (key: string, vars?: Record<string, string | number>) => string

async function runFix(fix: IssueFix, t: T): Promise<void> {
  if (fix === 'anchor-now') { await anchorNowWithFeedback(t); return }
  await verifyChainWithFeedback(t)
}

function IssueRow({ issue, onNavigate }: { issue: Issue; onNavigate: (v: string) => void }): JSX.Element {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const attention = issue.tier === 'attention'

  return (
    <div
      data-testid={`dashboard-issue-${issue.id}`}
      data-tier={issue.tier}
      className="relative flex items-start gap-3 p-4 pl-5 border-t border-redlog-border first:border-t-0"
    >
      {/* §4: state rides a left colour block; the row's ground stays surface.
          Only attention fills — a pending condition is worth printing and not
          worth a second red bar competing with the one that matters. */}
      <span
        aria-hidden
        className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${attention ? 'bg-redlog-danger' : 'bg-redlog-text-faint'}`}
      />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${attention ? 'text-redlog-danger' : 'text-redlog-text'}`}>{issue.title}</p>
        {issue.detail && <p className="text-xs text-redlog-text-dim mt-0.5 leading-relaxed">{issue.detail}</p>}
        {/* How long it has been true. The store keeps `since` across re-raises
            for this, and nothing read it — a chain that has been drifting for
            nine hours and one that broke a minute ago were the same line. */}
        <p className="text-xs text-redlog-text-faint mt-1 font-mono">
          {t('issues.sinceAge', { age: formatFreshness(issue.since, t) })}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {issue.fix && (
          <Button
            level="secondary"
            disabled={busy}
            data-testid={`dashboard-issue-fix-${issue.id}`}
            onClick={async () => {
              setBusy(true)
              // The condition clears (or does not) through the store, so there
              // is nothing to do with the result here: whichever it is, this
              // row re-renders or goes away on its own.
              try { await runFix(issue.fix as IssueFix, t) } finally { setBusy(false) }
            }}
          >
            {busy ? t('issues.fixRunning') : t(FIX_LABEL[issue.fix])}
          </Button>
        )}
        {issue.view && (
          <Button level="quiet" onClick={() => onNavigate(issue.view as string)}>
            {t('issues.goThere')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** The conditions currently true, or nothing at all. An empty "all clear"
 *  panel is a box that is right 95% of the time and therefore stops being
 *  read on the day it is not. */
export function DashboardIssues({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element | null {
  const issues = useIssues()
  const { t } = useI18n()
  // `since` is printed as an age, so it has to be re-rendered to stay true.
  // Half a minute, because the coarsest thing it prints is minutes.
  useTick(30_000)
  if (issues.length === 0) return null

  return (
    <section data-testid="dashboard-issues">
      <SectionLabel className="tracking-[0.15em] mb-3">
        {t('issues.needsAction', { count: issues.length })}
      </SectionLabel>
      <div className="rounded-lg bg-redlog-surface border border-redlog-border shadow-card overflow-hidden">
        {/* Already attention-first, oldest-first: snapshotIssues sorts, and
            doing it again here would be a second opinion about priority. */}
        {issues.map((i) => <IssueRow key={i.id} issue={i} onNavigate={onNavigate} />)}
      </div>
    </section>
  )
}
