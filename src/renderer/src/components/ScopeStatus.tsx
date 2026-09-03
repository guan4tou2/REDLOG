import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner } from './Feedback'
import { toast } from './Toast'
import { Ban } from 'lucide-react'
import { formatTime, formatDateTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'

const SCOPE_SUBTYPES = new Set(['scope_violation', 'scope_cleared', 'scope_recomputed'])

/** What the last boundary change did to what was already recorded.
 *
 *  No dismiss control, and none is needed: this is a projection of the newest
 *  `scope_recomputed` row, so it survives a reload and a project switch on its
 *  own and disappears when a later recompute replaces it. */
function RecomputeBanner({ summary, onOpenInTimeline }: {
  summary: Record<string, unknown>
  onOpenInTimeline?: (ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const n = (k: string): number => (typeof summary[k] === 'number' ? (summary[k] as number) : 0)
  const recomputed = n('recomputed')
  const flagged = n('newly_flagged')
  const clearedN = n('cleared')
  const truncated = (n('newly_flagged') - n('newly_flagged_written')) + (n('cleared') - n('cleared_written'))
  const ts = typeof summary.timestamp === 'number' ? (summary.timestamp as number) : null

  return (
    <div
      data-testid="scope-recomputed-banner"
      className="bg-redlog-surface border border-redlog-border rounded-lg p-3 space-y-1"
    >
      <p className="text-xs text-redlog-text-dim">
        {ts ? t('scope.recompute.banner', { time: formatDateTime(ts) }) : t('scope.recompute.bannerNoTime')}
      </p>
      {flagged === 0 && clearedN === 0 ? (
        <p className="text-xs text-redlog-text-dim">{t('scope.recompute.nothingChanged', { count: recomputed })}</p>
      ) : (
        <div className="flex items-baseline gap-4 text-sm">
          {([['recomputed', recomputed], ['newlyFlagged', flagged], ['cleared', clearedN]] as const).map(([key, value]) => (
            <span key={key} className="flex items-baseline gap-1">
              <span className="font-mono tabular-nums text-redlog-text">{value}</span>
              <span className="text-xs text-redlog-text-dim">{t(`scope.recompute.${key}`)}</span>
            </span>
          ))}
        </div>
      )}
      {truncated > 0 && (
        // Truncation the operator cannot see would make this banner claim a
        // smaller number than the engagement holds.
        <p className="text-xs text-redlog-text-dim">
          {t('scope.recompute.truncated', { count: truncated, cap: n('max_rows') })}
        </p>
      )}
      {ts && onOpenInTimeline && (
        <button
          onClick={() => onOpenInTimeline(ts)}
          className="text-xs text-redlog-text-dim hover:text-redlog-text underline decoration-dotted"
        >{t('scope.recompute.openInTimeline')}</button>
      )}
    </div>
  )
}

interface ViolationRow {
  id: string
  target: string
  command: string
  timestamp: number
  sourceTs?: number
  distance: string
  judged: 'live' | 'retroactive'
  cleared: boolean
}

export function ScopeStatus({ onOpenInTimeline }: { onOpenInTimeline?: (ts: number) => void } = {}): JSX.Element {
  const [violations, setViolations] = useState<ViolationRow[]>([])
  const [configured, setConfigured] = useState(false)
  const [chainLen, setChainLen] = useState(0)
  const [loading, setLoading] = useState(true)
  const [lastRecompute, setLastRecompute] = useState<Record<string, unknown> | null>(null)
  // Ephemeral: whether the withdrawn rows are expanded. Not persisted and not
  // navigation state — reopening the page starts from the active rows again,
  // which is what an operator wants under time pressure.
  const [showCleared, setShowCleared] = useState(false)
  const { t } = useI18n()

  const active = violations.filter((v) => !v.cleared)
  const cleared = violations.filter((v) => v.cleared)

  // §9's list contract, same as Findings/Loot/Search. The violation list is
  // the one an operator reaches for under time pressure — "which rule did this
  // hit, and where is it on the timeline" — so it should not be the one list
  // that needs a mouse.
  // Active first: a withdrawn violation is history, and the operator opened
  // this page to see what still stands.
  const shownViolations = (showCleared ? [...active, ...cleared] : active).slice(0, 10)
  const listNav = useListKeyboard({
    count: shownViolations.length,
    onActivate: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) },
    onJumpToTimeline: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) }
  })

  useEffect(() => {
    const refetch = (): void => {
      void window.redlog.scope.getViolations().then((r) => setViolations(r as ViolationRow[]))
      void window.redlog.scope.getLastRecompute?.().then(setLastRecompute).catch(() => { /* older preload */ })
    }
    Promise.all([
      window.redlog.scope.isConfigured().then(setConfigured),
      window.redlog.scope.getViolations().then((r) => setViolations(r as ViolationRow[])),
      window.redlog.chain.length().then(setChainLen)
    ]).then(() => setLoading(false))
    void window.redlog.scope.getLastRecompute?.().then(setLastRecompute).catch(() => { /* older preload */ })

    // A recompute publishes hundreds of rows in one tick, so the refetch is
    // narrowed to rows that can actually change this page and then coalesced —
    // otherwise the page re-queries once per written row.
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = window.redlog.events.onNew((event) => {
      const sub = String((event.data as Record<string, unknown>)?.subtype ?? '')
      if (event.agentType === 'system' && SCOPE_SUBTYPES.has(sub)) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(refetch, 100)
      }
      window.redlog.chain.length().then(setChainLen)
    })
    return () => { if (timer) clearTimeout(timer); unsub() }
  }, [])

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-redlog-text">{t('scope.title')}</h2>
        {violations.length > 0 && (
          <button
            onClick={async () => {
              const p = await (window.redlog.data as { exportViolations?: () => Promise<string | null> }).exportViolations?.()
              if (p) toast(t('toast.exportedTo', { path: p }), 'success')
              else toast(t('toast.exportFailed'), { type: 'error', why: t('toast.exportFailedWhy') })
            }}
            className="px-2.5 py-1 text-xs bg-redlog-elevated text-redlog-text-dim rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
            title={t('scope.exportHint')}
          >{t('scope.export')}</button>
        )}
      </div>

      {lastRecompute && <RecomputeBanner summary={lastRecompute} onOpenInTimeline={onOpenInTimeline} />}

      <div className="bg-redlog-surface border border-redlog-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-redlog-text text-sm font-medium">{t('scope.monitor')}</span>
          {configured ? (
            <span className="text-green-400 text-xs bg-green-400/10 px-2 py-0.5 rounded">{t('scope.active')}</span>
          ) : (
            <span className="text-redlog-text-dim text-xs bg-redlog-elevated px-2 py-0.5 rounded">{t('scope.notSet')}</span>
          )}
        </div>
        {configured && violations.length === 0 && (
          <p className="text-green-400 text-xs">{t('scope.allInScope')}</p>
        )}
        {active.length > 0 && (
          // The digit is not red. §21 rule 6: danger colour on a number turns a
          // count into an alarm that never stops ringing on an eight-hour
          // screen — the wording carries the severity, the number stays legible.
          <div className="text-sm flex items-baseline gap-1.5">
            <span className="font-mono tabular-nums text-redlog-text">{active.length}</span>
            <span className="text-redlog-text-dim">{t('scope.violationsCountLabel')}</span>
            {cleared.length > 0 && (
              <button
                onClick={() => setShowCleared((v) => !v)}
                data-testid="scope-show-cleared"
                className="ml-auto text-xs text-redlog-text-dim hover:text-redlog-text underline decoration-dotted"
              >
                {t('scope.showCleared', { count: cleared.length })}
              </button>
            )}
          </div>
        )}
        {!configured && (
          <div className="flex flex-col items-center py-6 gap-2">
            <div className="w-12 h-12 rounded-full bg-redlog-elevated border border-redlog-border flex items-center justify-center">
              <Ban size={20} strokeWidth={1.5} aria-hidden className="text-redlog-text-faint" />
            </div>
            <p className="text-redlog-text-dim text-xs">
              {t('scope.hint')}
            </p>
          </div>
        )}
      </div>

      <div className="bg-redlog-surface border border-redlog-border rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-redlog-text text-sm font-medium">{t('scope.evidenceLog')}</span>
          <span className="text-redlog-text-dim text-xs">{t('scope.entries', { count: chainLen })}</span>
        </div>
      </div>

      {shownViolations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm text-redlog-text-dim">{t('scope.recentViolations')}</h3>
          <div
            className="space-y-1"
            {...listNav.containerProps}
            aria-label={t('scope.violationsLabel', { count: shownViolations.length })}
          >
          {shownViolations.map((v, i) => {
            const rowProps = listNav.itemProps(i)
            return (
            <button
              key={i}
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); onOpenInTimeline?.(v.timestamp) }}
              disabled={!onOpenInTimeline}
              className={`w-full text-left rounded p-2 border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 disabled:cursor-default transition-colors ${
                v.cleared
                  ? 'bg-redlog-elevated/40 border-redlog-border hover:bg-redlog-elevated'
                  : 'bg-red-900/20 border-red-800/30 hover:bg-red-900/30 disabled:hover:bg-red-900/20'
              }`}
              // A live row carries no label — being judged at the time is the
              // norm, and §5.2 reports exceptions, not the rule. The attribute
              // is there so a test can tell the two apart.
              data-testid={v.judged === 'retroactive' ? 'scope-judged-retroactive' : 'scope-judged-live'}
              title={onOpenInTimeline ? t('scope.openInTimeline') : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-mono ${v.cleared ? 'text-redlog-text-dim' : 'text-red-300'}`}>{v.target}</span>
                {v.judged === 'retroactive' && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-400 shrink-0"
                    title={t('scope.judged.retroactiveHint')}
                  >{t('scope.judged.retroactive')}</span>
                )}
                {v.cleared && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim shrink-0"
                    title={t('scope.clearedHint')}
                  >{t('scope.cleared')}</span>
                )}
              </div>
              <div title={v.command} className="text-redlog-text-dim text-xs truncate">{v.command}</div>
              <div className="text-redlog-text-faint text-xs font-mono tabular-nums">
                {formatTime(v.sourceTs ?? v.timestamp, { seconds: true })}
              </div>
            </button>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}
