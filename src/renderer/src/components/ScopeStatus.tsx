import { PAGE_COLUMN } from '../lib/pageColumn'
import { SCOPE_VIOLATION_SUBTYPE } from '../../../core/scope-vocabulary'
import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner } from './Feedback'
import { Button } from './Button'
import { formatTime, formatDateTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useInfiniteScroll } from '../lib/useInfiniteScroll'
import { ListFooter } from './ListFooter'
import { useReadState } from '../lib/readState'
import { ChevronDown, ChevronRight } from 'lucide-react'

const SCOPE_SUBTYPES = new Set([SCOPE_VIOLATION_SUBTYPE, 'scope_cleared', 'scope_recomputed'])

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
      <p className="text-xs text-redlog-text-faint">{t('scope.recompute.explain')}</p>
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

interface ObservationRow {
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
      window.redlog.scope.isConfigured(), window.redlog.scope.getObservations(),
      window.redlog.scope.getObservationCount(), window.redlog.chain.length(),
      window.redlog.scope.getLastRecompute()
    ])
    return { configured, observations: result.rows as ObservationRow[], truncated: result.truncated, standing, chainLen, lastRecompute }
  }
  const read = useReadState<Awaited<ReturnType<typeof loadScope>> | null>(loadScope)
  const { configured = false, observations = [], truncated = false, standing = 0, chainLen = 0, lastRecompute = null } = read.state.value ?? {}

  // Ephemeral: whether the withdrawn rows are expanded. Not persisted and not
  // navigation state — reopening the page starts from the active rows again,
  // which is what an operator wants under time pressure.
  const [showCleared, setShowCleared] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const detail = useReadState(async () => {
    const [event] = await window.redlog.events.getById([expandedId!])
    if (!event) throw new Error('Observation unavailable')
    const ids = Array.isArray(event.data._causes) ? event.data._causes.filter((id): id is string => typeof id === 'string') : []
    const causes = ids.length ? await window.redlog.events.getById(ids) : []
    const source = causes.find(row => row.agentType === 'shell' && typeof row.data.command === 'string')
    return { id: event.id, command: source?.data.command as string | undefined,
      rule: typeof event.data.matched_by === 'string' ? event.data.matched_by : null }
  }, expandedId !== null, [expandedId])

  // The store holds more violation records than the page read.

  // How many observations stand across the whole chain: the status bar's number.
  // The rows are only the newest records, so a count or an "all within scope"
  // taken from them alone could contradict it (TESTING.md G-S3).

  const { t } = useI18n()

  const active = observations.filter((v) => !v.cleared)
  const cleared = observations.filter((v) => v.cleared)

  // §9's list contract, same as Findings/Loot/Search. The violation list is
  // the one an operator reaches for under time pressure — "which rule did this
  // hit, and where is it on the timeline" — so it should not be the one list
  // that needs a mouse.
  // Active first: a withdrawn violation is history, and the operator opened
  // this page to see what still stands.
  // Paged like every other list (§9): the page used to cut at 10 of up to 500
  // with nothing saying so (Constitution IV).
  const paged = useInfiniteScroll(showCleared ? [...active, ...cleared] : active)
  const shownObservations = paged.visible
  const listNav = useListKeyboard({
    count: shownObservations.length,
    onActivate: (i) => { const v = shownObservations[i]; if (v) onOpenInTimeline?.(v.timestamp) },
    onJumpToTimeline: (i) => { const v = shownObservations[i]; if (v) onOpenInTimeline?.(v.timestamp) }
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
    <div className="p-pad overflow-auto h-full"><div className={`${PAGE_COLUMN} space-y-4`}>
      {lastRecompute && <RecomputeBanner summary={lastRecompute} onOpenInTimeline={onOpenInTimeline} />}

      <div className="bg-redlog-surface border border-redlog-border rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-redlog-border">
          <div>
            <h2 className="text-sm font-semibold text-redlog-text">{t('scope.observationsTitle')}</h2>
            <p className="text-xs text-redlog-text-faint mt-0.5">{t('scope.observationsCaption')}</p>
          </div>
          {standing > 0 && cleared.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-redlog-text-dim">
              <input type="checkbox" data-testid="scope-show-cleared" checked={showCleared} onChange={() => setShowCleared((v) => !v)} className="accent-redlog-accent" />
              {t('scope.showCleared', { count: cleared.length })}
            </label>
          )}
        </div>
        {standing > 0 && (
          // The digit is not red. §21 rule 6: danger colour on a number turns a
          // count into an alarm that never stops ringing on an eight-hour
          // screen — the wording carries the severity, the number stays legible.
          <div className="flex items-baseline gap-1.5 px-4 py-2.5 text-sm border-b border-redlog-border">
            <span className="font-mono tabular-nums text-redlog-text">{standing}</span>
            <span className="text-redlog-text-dim">{t('scope.observationsCountLabel')}</span>
          </div>
        )}
        {configured && standing === 0 && observations.length === 0 && (
          <p className="px-4 py-6 text-sm text-emerald-400">{t('scope.allInScope')}</p>
        )}
        {!configured && (
          <p className="px-4 py-6 text-sm text-redlog-text-dim">{t('scope.hint', { page: t('settings.pageScope') })}</p>
        )}
        {shownObservations.length > 0 && (
          <div
            className="divide-y divide-redlog-border"
            {...listNav.containerProps}
            aria-label={t('scope.observationsLabel', { count: paged.total })}
          >
          {shownObservations.map((v, i) => {
            const rowProps = listNav.itemProps(i)
            const open = expandedId === v.id
            return (
            <div key={v.id}>
            <button
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); setExpandedId(previous => previous === v.id ? null : v.id) }}
              aria-expanded={open}
              className={`w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-redlog-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors ${open ? 'bg-redlog-elevated/40' : ''}`}
              // A live row carries no label — being judged at the time is the
              // norm, and §5.2 reports exceptions, not the rule. The attribute
              // is there so a test can tell the two apart.
              data-testid={v.judged === 'retroactive' ? 'scope-judged-retroactive' : 'scope-judged-live'}
            >
              {open
                ? <ChevronDown size={14} className="mt-1 shrink-0 text-redlog-text-faint" aria-hidden />
                : <ChevronRight size={14} className="mt-1 shrink-0 text-redlog-text-faint" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm font-mono break-all ${v.cleared ? 'text-redlog-text-dim' : 'text-redlog-text'}`}>{v.target}</span>
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
                </span>
                <span title={v.command} className="mt-1 block text-redlog-text-dim text-xs font-mono truncate">{v.command}</span>
              </span>
              <span className="shrink-0 text-redlog-text-faint text-xs font-mono tabular-nums">
                {formatTime(v.sourceTs ?? v.timestamp, { seconds: true })}
              </span>
            </button>
            {open && <div className="ml-9 mr-4 mb-3 border-l-2 border-redlog-border pl-3 py-1 space-y-2 text-xs" data-testid="scope-observation-detail">
              {/* Stitch 02: why, by which rule, and from which event — three facts, side by side. */}
              <dl data-testid="scope-observation-facts" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="min-w-0 rounded bg-redlog-bg p-2">
                  <dt className="text-redlog-text-faint">{t('scope.fact.reason')}</dt>
                  <dd className="m-0 text-redlog-text">{t(`scope.distance.${['excluded', 'adjacent_domain', 'adjacent_subnet', 'unrelated'].includes(v.distance) ? v.distance : 'unknown'}`)}</dd>
                </div>
                <div className="min-w-0 rounded bg-redlog-bg p-2">
                  <dt className="text-redlog-text-faint">{t('scope.fact.rule')}</dt>
                  <dd className="m-0 truncate font-mono text-redlog-text" title={detail.state.value?.id === v.id ? detail.state.value.rule ?? undefined : undefined}>
                    {detail.state.value?.id === v.id && detail.state.value.rule ? detail.state.value.rule : '—'}
                  </dd>
                </div>
                <div className="min-w-0 rounded bg-redlog-bg p-2">
                  <dt className="text-redlog-text-faint">{t('scope.fact.source')}</dt>
                  <dd className="m-0 font-mono text-redlog-text">{formatDateTime(v.sourceTs ?? v.timestamp)}</dd>
                </div>
              </dl>
              {detail.state.phase === 'loading' && <LoadingSpinner />}
              {detail.state.phase === 'failed' && <div role="alert">{t('scope.detailFailed')} <Button level="quiet" size="compact" onClick={detail.retry}>{t('common.retry')}</Button></div>}
              {detail.state.phase === 'loaded' && detail.state.value?.id === v.id && !detail.state.value.command && <p className="text-amber-400">{t('scope.commandPreview')}</p>}
              {detail.state.phase === 'loaded' && v.distance === 'excluded' && detail.state.value?.id === v.id && !detail.state.value.rule && <p className="text-redlog-text-faint">{t('scope.ruleUnavailable')}</p>}
              {detail.state.phase === 'loaded' && detail.state.value?.id === v.id && <pre className="font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{detail.state.value.command ?? v.command}</pre>}
              <div className="flex flex-wrap gap-2">
                {onOpenInTimeline && <Button size="compact" onClick={() => onOpenInTimeline(v.timestamp)}>{t('scope.openInTimeline')}</Button>}
                {onOpenSettings && <Button size="compact" onClick={() => onOpenSettings(v.target)}>{t('scope.editRule')}</Button>}
              </div>
            </div>}
            </div>
            )
          })}
          </div>
        )}
        {shownObservations.length > 0 && <ListFooter shown={paged.shown} total={paged.total} sentinelRef={paged.sentinelRef} />}
        {truncated && (
          // Inside the panel but outside the list: the newest records can all be
          // withdrawn while older ones stand, and the cut has to be said either way.
          <p data-testid="scope-truncated" className="px-4 py-2.5 text-xs text-amber-400 border-t border-redlog-border">{t('scope.truncated')}</p>
        )}
      </div>

      <div className="bg-redlog-surface border border-redlog-border rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-redlog-text">{t('scope.integrityTitle')}</h2>
            <p className="text-xs text-redlog-text-faint mt-0.5">{t('scope.integrityCaption')}</p>
          </div>
          <span className="text-redlog-text-dim text-xs font-mono tabular-nums">{t('scope.entries', { count: chainLen })}</span>
        </div>
        {onOpenSettings && (
          <div className="flex flex-wrap items-center gap-2 border-t border-redlog-border px-4 py-3 text-xs text-redlog-text-dim">
            <span>{t('scope.rulesLiveInSettings')}</span>
            <Button level="quiet" size="compact" onClick={() => onOpenSettings()}>{t('scope.openSettingsLink', { page: t('settings.pageScope') })}</Button>
          </div>
        )}
      </div>
    </div></div>
  )
}
