import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner } from './Feedback'
import { Button } from './Button'
import { formatTime, formatDateTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useInfiniteScroll } from '../lib/useInfiniteScroll'
import { ListFooter } from './ListFooter'
import { useReadState } from '../lib/readState'

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

export function ScopeStatus({ onOpenInTimeline, onOpenSettings }: { onOpenInTimeline?: (ts: number) => void; onOpenSettings?: (candidate?: string) => void } = {}): JSX.Element {
  const loadScope = async () => {
    const [configured, result, standing, chainLen, lastRecompute] = await Promise.all([
      window.redlog.scope.isConfigured(), window.redlog.scope.getViolations(),
      window.redlog.scope.getViolationCount(), window.redlog.chain.length(),
      window.redlog.scope.getLastRecompute()
    ])
    return { configured, violations: result.rows as ViolationRow[], truncated: result.truncated, standing, chainLen, lastRecompute }
  }
  const read = useReadState<Awaited<ReturnType<typeof loadScope>> | null>(loadScope)
  const { configured = false, violations = [], truncated = false, standing = 0, chainLen = 0, lastRecompute = null } = read.state.value ?? {}

  // Ephemeral: whether the withdrawn rows are expanded. Not persisted and not
  // navigation state — reopening the page starts from the active rows again,
  // which is what an operator wants under time pressure.
  const [showCleared, setShowCleared] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const detail = useReadState(async () => {
    const [event] = await window.redlog.events.getById([expandedId!])
    if (!event) throw new Error('Violation unavailable')
    const ids = Array.isArray(event.data._causes) ? event.data._causes.filter((id): id is string => typeof id === 'string') : []
    const causes = ids.length ? await window.redlog.events.getById(ids) : []
    const source = causes.find(row => row.agentType === 'shell' && typeof row.data.command === 'string')
    return { id: event.id, command: source?.data.command as string | undefined,
      rule: typeof event.data.matched_by === 'string' ? event.data.matched_by : null }
  }, expandedId !== null, [expandedId])

  // The store holds more violation records than the page read.

  // How many violations stand across the whole chain: the status bar's number.
  // The rows are only the newest records, so a count or an "all within scope"
  // taken from them alone could contradict it (TESTING.md G-S3).

  const { t } = useI18n()

  const active = violations.filter((v) => !v.cleared)
  const cleared = violations.filter((v) => v.cleared)

  // §9's list contract, same as Findings/Loot/Search. The violation list is
  // the one an operator reaches for under time pressure — "which rule did this
  // hit, and where is it on the timeline" — so it should not be the one list
  // that needs a mouse.
  // Active first: a withdrawn violation is history, and the operator opened
  // this page to see what still stands.
  // Paged like every other list (§9): the page used to cut at 10 of up to 500
  // with nothing saying so (Constitution IV).
  const paged = useInfiniteScroll(showCleared ? [...active, ...cleared] : active)
  const shownViolations = paged.visible
  const listNav = useListKeyboard({
    count: shownViolations.length,
    onActivate: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) },
    onJumpToTimeline: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) }
  })

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const refetch = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (live) read.retry() }, 100)
    }
    const unsub = window.redlog.events.onNewBatch((events) => {
      const affectsScope = events.some(event => event.agentType === 'system'
        && SCOPE_SUBTYPES.has(String(event.data.subtype ?? '')))
      if (affectsScope) refetch()
      else void window.redlog.chain.length().then(chainLen => {
        if (live) read.update(prev => prev ? { ...prev, chainLen } : prev)
      }).catch(() => { if (live) refetch() })
    })
    return () => { live = false; if (timer) clearTimeout(timer); unsub() }
  }, [read.retry, read.update])

  if (read.state.phase === 'failed') {
    return <div role="alert" className="p-pad space-y-2 text-sm text-red-400">
      <p>{t('scope.loadFailed')}</p>
      <p className="break-words text-xs">{read.state.error}</p>
      <Button onClick={read.retry}>{t('common.retry')}</Button>
    </div>
  }
  if (!read.state.value) return <LoadingSpinner />

  return (
    <div className="p-pad space-y-4 overflow-auto h-full">
      <div>
        <h2 className="text-lg font-semibold text-redlog-text">{t('scope.title')}</h2>
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
        {configured && standing === 0 && violations.length === 0 && (
          <p className="text-green-400 text-xs">{t('scope.allInScope')}</p>
        )}
        {standing > 0 && (
          // The digit is not red. §21 rule 6: danger colour on a number turns a
          // count into an alarm that never stops ringing on an eight-hour
          // screen — the wording carries the severity, the number stays legible.
          <div className="text-sm flex items-baseline gap-1.5">
            <span className="font-mono tabular-nums text-redlog-text">{standing}</span>
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-redlog-text-dim text-xs">
              {t('scope.hint', { page: t('settings.pageScope') })}
            </p>
            {onOpenSettings && <Button level="quiet" onClick={() => onOpenSettings()}>{t('browser.openSettings')}</Button>}
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
            aria-label={t('scope.violationsLabel', { count: paged.total })}
          >
          {shownViolations.map((v, i) => {
            const rowProps = listNav.itemProps(i)
            return (
            <div key={v.id}>
            <button
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); setExpandedId(previous => previous === v.id ? null : v.id) }}
              aria-expanded={expandedId === v.id}
              className={`w-full text-left rounded p-2 border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 disabled:cursor-default transition-colors ${
                v.cleared
                  ? 'bg-redlog-elevated/40 border-redlog-border hover:bg-redlog-elevated'
                  : 'bg-red-900/20 border-red-800/30 hover:bg-red-900/30 disabled:hover:bg-red-900/20'
              }`}
              // A live row carries no label — being judged at the time is the
              // norm, and §5.2 reports exceptions, not the rule. The attribute
              // is there so a test can tell the two apart.
              data-testid={v.judged === 'retroactive' ? 'scope-judged-retroactive' : 'scope-judged-live'}

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
            {expandedId === v.id && <div className="px-3 py-2 space-y-2 text-xs" data-testid="scope-violation-detail">
              <p className="text-redlog-text-dim">{t(`scope.distance.${['excluded', 'adjacent_domain', 'adjacent_subnet', 'unrelated'].includes(v.distance) ? v.distance : 'unknown'}`)}{detail.state.value?.id === v.id && detail.state.value.rule ? ` · ${detail.state.value.rule}` : ''}</p>
              {detail.state.phase === 'loading' && <LoadingSpinner />}
              {detail.state.phase === 'failed' && <div role="alert">{t('scope.detailFailed')} <Button level="quiet" size="compact" onClick={detail.retry}>{t('common.retry')}</Button></div>}
              {detail.state.phase === 'loaded' && detail.state.value?.id === v.id && !detail.state.value.command && <p className="text-amber-400">{t('scope.commandPreview')}</p>}
              {detail.state.phase === 'loaded' && v.distance === 'excluded' && detail.state.value?.id === v.id && !detail.state.value.rule && <p className="text-redlog-text-faint">{t('scope.ruleUnavailable')}</p>}
              {detail.state.phase === 'loaded' && detail.state.value?.id === v.id && <pre className="font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{detail.state.value.command ?? v.command}</pre>}
              <div className="flex flex-wrap gap-2">
                {onOpenInTimeline && <Button level="quiet" size="compact" onClick={() => onOpenInTimeline(v.timestamp)}>{t('scope.openInTimeline')}</Button>}
                {onOpenSettings && <Button level="quiet" size="compact" onClick={() => onOpenSettings(v.target)}>{t('scope.editRule')}</Button>}
              </div>
            </div>}
            </div>
            )
          })}
          </div>
          <ListFooter shown={paged.shown} total={paged.total} sentinelRef={paged.sentinelRef} />
        </div>
      )}
      {truncated && (
        // Outside the list: the newest records can all be withdrawn while
        // older ones stand, and the cut has to be said either way.
        <p data-testid="scope-truncated" className="text-xs text-amber-400">{t('scope.truncated')}</p>
      )}
    </div>
  )
}
