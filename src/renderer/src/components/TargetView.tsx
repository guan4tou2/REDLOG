import { PAGE_COLUMN } from '../lib/pageColumn'
import { Button } from './Button'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { eventTitle } from '../lib/eventTitle'
import { agentTypeLabel } from '../lib/timelineDomain'
import { toast, toastDeferred } from './Toast'
import { useListKeyboard } from '../lib/useListKeyboard'
import { EmptyState } from './EmptyState'
import { Crosshair, ChevronRight, ChevronDown } from 'lucide-react'
import { hostInScope } from '../lib/scope'
import { useSharedFilter } from '../lib/FilterContext'

interface TargetEntry {
  target: string
  firstSeen: number
  lastSeen: number
  inScope: boolean | null
  eventCount: number
}

interface TargetViewProps {
  /** §7: a target row leads to the Timeline, narrowed to that target through
   *  the shared filter (spec 038), which this view sets before calling. Optional
   *  so the view still renders standalone in tests. */
  onOpenInTimeline?: (ts: number) => void
}

export function TargetView({ onOpenInTimeline }: TargetViewProps = {}): JSX.Element {
  const { setTargetId } = useSharedFilter()
  const [targets, setTargets] = useState<TargetEntry[]>([])
  // §5.4: distinguish "still loading" from "genuinely empty" so a project that
  // has targets doesn't flash the no-targets empty state on the initial async.
  const [loading, setLoading] = useState(true)
  // A failed read is shown as one, never as an empty project (no targets) or
  // as everything in scope (no rules).
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scopeFailed, setScopeFailed] = useState(false)
  const [filter, setFilter] = useState<'all' | 'in_scope' | 'out_scope'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [evidence, setEvidence] = useState<RedLogEvent[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // Scope target list from project config — used to compute the inScope column
  // on each target. Empty when config isn't set (in which case every target
  // shows as "in-scope" since there's no rule to violate).
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [excludeTargets, setExcludeTargets] = useState<string[]>([])
  const [activeTarget, setActiveTarget] = useState<string | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const { t } = useI18n()
  // Re-read the selected target's first page, when a live row could not be
  // checked against it. Declared above the effect that calls it.
  const reloadEvidenceRef = useRef(async (target: string): Promise<void> => {
    const page = await window.redlog.events.queryPage({ targetId: target, excludeHousekeeping: true, limit: 200 })
    if (selectedRef.current !== target) return
    setEvidence(page.items)
    setHasMore(page.hasMore)
    setNextCursor(page.nextCursor)
  })

  useEffect(() => {
    // Refresh both on mount and whenever the operator saves settings — the
    // auto-save (v0.6.21) doesn't broadcast, but any nav back to this view
    // will re-mount and pick up the current config.
    loadScope()
    loadTargets()
    const unsub = window.redlog.events.onNewBatch((events) => {
      if (events.some((evt) => evt.targetId || evt.data?.detectedTarget)) loadTargets()
      const sel = selectedRef.current
      const candidates = sel ? events.filter((evt) => evt.targetId).slice(-1000) : []
      if (!sel || candidates.length === 0) return
      // A live row joins the list through the page's own predicates: the
      // target in any casing, and housekeeping aside. A plain `===` here
      // missed the other casing and let plumbing rows in (spec 038 SC-002).
      window.redlog.events.matchIds({ ids: candidates.map((e) => e.id), filter: { targetId: sel }, excludeHousekeeping: true })
        .then((ids) => {
          if (selectedRef.current !== sel || ids.length === 0) return
          const admitted = new Set(ids)
          setEvidence((prev) => {
            const known = new Set(prev.map((e) => e.id))
            return [...candidates.filter((e) => admitted.has(e.id) && !known.has(e.id)).reverse(), ...prev]
          })
        })
        // The header count is the aggregate, so a missed row shows as
        // "loaded N of M" rather than as a complete list; re-read the page.
        .catch(() => { if (selectedRef.current === sel) void reloadEvidenceRef.current(sel) })
    })
    void window.redlog.targetContext.get().then(setActiveTarget)
    const unsubTarget = window.redlog.targetContext.onChange(setActiveTarget)
    return () => { unsub(); unsubTarget() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reclassify existing targets whenever scope config changes (e.g. operator
  // added a scope entry after seeing an out-of-scope hit).
  useEffect(() => { if (targets.length > 0) loadTargets() }, [scopeTargets, excludeTargets, scopeFailed])

  function loadScope(): void {
    window.redlog.config.get().then((c) => {
      const cfg = c as { scope?: { targets?: string[]; excludeTargets?: string[] } } | null
      setScopeTargets(cfg?.scope?.targets ?? [])
      setExcludeTargets(cfg?.scope?.excludeTargets ?? [])
      setScopeFailed(false)
    }).catch(() => setScopeFailed(true))
  }

  async function loadTargets(): Promise<void> {
    // Counts + first/last-seen are aggregated in SQL over the whole timeline
    // (both tiers), covering every event type that carries detectedTarget —
    // loot / http_navigation / screenshots, not only shell (audit finding #34).
    // This replaced a client-side rollup over a capped 1000-row window, which
    // dropped targets seen only in older events and truncated every count (§9).
    let rows: Awaited<ReturnType<typeof window.redlog.events.aggregateTargets>>
    try {
      rows = await window.redlog.events.aggregateTargets()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      setLoading(false)
      return
    }
    setLoadError(null)
    // Classify each target as in-scope / out-of-scope from the current scope
    // config (audit finding #33 — before this the field was null and both
    // filter chips returned empty). Scope-unset means every target is in-scope
    // (no rule to violate).
    const list: TargetEntry[] = rows.map((r) => ({
      target: r.target,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      eventCount: r.eventCount,
      // Unknown, not in scope, when the rules could not be read, and also when
      // none were ever declared: with no rule there is nothing to be inside of.
      inScope: scopeFailed || (scopeTargets.length === 0 && excludeTargets.length === 0) ? null : hostInScope(r.target, scopeTargets, excludeTargets)
    }))
    setTargets(list)
    setLoading(false)
  }

  async function addToScope(tgt: TargetEntry): Promise<void> {
    // One-click round-trip to Settings ▸ Scope: append
    // this target to config.scope.targets and reload
    // scope config (audit #36).
    const cfg = await window.redlog.config.get() as
      { scope?: { targets?: string[] }; engagement?: { id?: string } } | null
    if ((cfg?.scope?.targets ?? []).includes(tgt.target)) return
    // Which project this button was pressed in. The write
    // happens seconds from now; the main process merges the
    // one target into the config as it is THEN, and refuses
    // if another project is open by that time.
    const projectId = cfg?.engagement?.id
    // Widening scope is the one direction that can turn
    // an out-of-scope finding into an in-scope one after
    // the fact, so §10 defers the write: the chip shows
    // the target as in-scope at once, but nothing is
    // saved — and no `system.config_changed` is written
    // — until the undo window closes.
    setScopeTargets((prev) => prev.includes(tgt.target) ? prev : [...prev, tgt.target])
    toastDeferred(
      t('targets.addedToScope', { target: tgt.target }),
      () => {
        const failed = (detail?: string): void => {
          setScopeTargets((prev) => prev.filter((x) => x !== tgt.target))
          toast(t('targets.addToScopeFailed', { target: tgt.target }), { type: 'error', detail })
        }
        window.redlog.scope.addTarget(tgt.target, { expectProjectId: projectId })
          .then((ok) => {
            if (ok) window.dispatchEvent(new CustomEvent('redlog:config-saved'))
            else failed(t('targets.addToScopeFailedWhy'))
          })
          .catch((err) => failed(err instanceof Error ? err.message : String(err)))
      },
      {
        why: t('targets.addedToScopeWhy'),
        revert: () => setScopeTargets((prev) => prev.filter((x) => x !== tgt.target))
      }
    )
  }


  const PAGE_SIZE = 200

  const loadEvidence = useCallback(async (target: string) => {
    if (selected === target) {
      setSelected(null)
      setEvidence([])
      setHasMore(false)
      setNextCursor(null)
      return
    }
    setSelected(target)
    // Housekeeping aside, as the count and the Timeline leave it (spec 038 SC-002).
    try {
      const page = await window.redlog.events.queryPage({ targetId: target, excludeHousekeeping: true, limit: PAGE_SIZE })
      setEvidence(page.items)
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } catch (err) {
      setEvidence([])
      setHasMore(false)
      toast(t('targets.evidenceFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }, [selected, t])

  const loadMore = useCallback(async () => {
    if (!selected || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await window.redlog.events.queryPage({ targetId: selected, excludeHousekeeping: true, limit: PAGE_SIZE, cursor: nextCursor })
      setEvidence((prev) => [...prev, ...page.items])
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } catch (err) {
      toast(t('targets.evidenceFailed'), { type: 'error', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoadingMore(false)
    }
  }, [selected, nextCursor, loadingMore, t])

  // The filtered target list must be fully built BEFORE the keyboard hook
  // reads its length. These were interleaved — `listNav` sat inside the
  // `targets.filter` callback and read `filtered.length` mid-filter — which is
  // a temporal-dead-zone crash that only fires once there is a target to
  // filter, and a Rules-of-Hooks violation besides. The static keyboard
  // contract test is a grep, so it never saw it; e2e/timeline-evidence.spec.ts did.
  const needle = query.trim().toLowerCase()
  const filtered = targets.filter((tgt) => {
    if (needle && !tgt.target.toLowerCase().includes(needle)) return false
    if (filter === 'in_scope') return tgt.inScope === true
    if (filter === 'out_scope') return tgt.inScope === false
    return true
  })
  // With no readable rule there is no in/out to filter by.
  const scopeKnown = !scopeFailed && (scopeTargets.length > 0 || excludeTargets.length > 0)

  // §7's main path: target → expand its commands → ⌘↩ to the Timeline.
  const listNav = useListKeyboard({
    count: filtered.length,
    onActivate: (i) => { const tgt = filtered[i]; if (tgt) void loadEvidence(tgt.target) },
    onJumpToTimeline: (i) => {
      const tgt = filtered[i]
      if (!tgt) return
      // One target control: the FilterBar chip, the same target_id predicate
      // the count on this page comes from.
      setTargetId(tgt.target)
      onOpenInTimeline?.(tgt.lastSeen)
    },
    onEscape: () => setSelected(null)
  })

  const badge = (inScope: boolean | null): JSX.Element => inScope === true
    ? <span className="text-xs text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">{t('targets.inScopeBadge')}</span>
    : inScope === false
      ? <span className="text-xs text-amber-300 bg-amber-400/10 px-1.5 py-0.5 rounded">{t('targets.out')}</span>
      // Two different facts: no rule was ever declared, or the rules could not be read.
      : <span className="text-xs text-redlog-text-dim bg-redlog-elevated px-1.5 py-0.5 rounded">{scopeFailed ? t('targets.scopeUnknown') : t('targets.scopeUnset')}</span>

  return (
    <div className="p-pad h-full overflow-auto"><div className={`${PAGE_COLUMN} space-y-4`}>
      <div className="bg-redlog-surface border border-redlog-border rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 border-b border-redlog-border">
          <div>
          <h2 className="text-sm font-semibold text-redlog-text">{t('targets.panelTitle')}</h2>
          <p className="text-xs text-redlog-text-faint mt-0.5">{t('targets.panelCaption')}</p>
          </div>
          <span className="text-xs text-redlog-text-dim">{t('targets.sortedByRecent')}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-redlog-border">
          <input type="search" data-testid="targets-search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('targets.searchPlaceholder')} aria-label={t('targets.searchLabel')}
            className="min-w-[12rem] flex-1 max-w-md rounded border border-redlog-border bg-redlog-bg px-3 py-1.5 text-sm text-redlog-text focus:outline-none focus:border-redlog-accent" />
          <div className="flex gap-1 rounded border border-redlog-border p-0.5" role="group" aria-label={t('targets.scopeFilter')}>
            {(['all', 'in_scope', 'out_scope'] as const).map((f) => (
              <button
                key={f}
                type="button"
                disabled={f !== 'all' && !scopeKnown}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs rounded disabled:opacity-50 disabled:cursor-default ${
                  filter === f ? 'bg-redlog-elevated text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'
                }`}
              >
                {f === 'all' ? t('targets.all') : f === 'in_scope' ? t('targets.inScope') : t('targets.outOfScope')}
              </button>
            ))}
          </div>
        </div>

      {scopeFailed && (
        <div data-testid="targets-scope-failed" role="status" className="mx-4 my-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t('targets.scopeFailed')}{' '}
          <button type="button" onClick={loadScope} className="underline hover:text-amber-100">{t('common.retry')}</button>
        </div>
      )}
      {loadError && (
        <div data-testid="targets-load-error" role="alert" className="mx-4 my-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div>{t('targets.loadFailed')}</div>
          <div className="mt-1 truncate font-mono text-redlog-text-faint" title={loadError}>{loadError}</div>
          <button type="button" onClick={() => { setLoading(true); void loadTargets() }} className="mt-2 text-red-300 underline hover:text-red-200">
            {t('common.retry')}
          </button>
        </div>
      )}
      {filtered.length === 0 ? (
        // Hold the empty state until the first aggregation resolves — otherwise
        // a project that has targets flashes "no targets" for a frame (m9).
        loading || loadError ? null : targets.length > 0 ? (
          <p className="px-4 py-8 text-center text-sm text-redlog-text-dim">{t('targets.noneMatch')}</p>
        ) : (
          <EmptyState
            icon={Crosshair}
            title={t('targets.empty')}
            reason={t('targets.emptyReason')}
          />
        )
      ) : (
        <div className="divide-y divide-redlog-border" {...listNav.containerProps} aria-label={t('targets.listLabel', { count: filtered.length })}>
          {filtered.map((tgt, i) => {
            const rowProps = listNav.itemProps(i)
            const open = selected === tgt.target
            return (
            <div key={tgt.target}>
              <div
                {...rowProps}
                ref={(el) => rowProps.ref(el)}
                onClick={() => { rowProps.onClick(); loadEvidence(tgt.target) }}
                className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-redlog-elevated/60 ${open ? 'bg-redlog-elevated/40' : ''}`}
              >
                {open
                  ? <ChevronDown size={14} className="mt-1 shrink-0 text-redlog-text-faint" aria-hidden />
                  : <ChevronRight size={14} className="mt-1 shrink-0 text-redlog-text-faint" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-redlog-text font-mono text-sm break-all">{tgt.target}</span>
                    {badge(tgt.inScope)}
                    {activeTarget === tgt.target && (
                      <span className="text-xs text-redlog-accent bg-redlog-accent/10 px-1.5 py-0.5 rounded">{t('activeTarget.current')}</span>
                    )}
                  </div>
                  <div className="mt-1 text-redlog-text-dim text-xs">
                    {t('targets.first', { time: formatTime(tgt.firstSeen, { seconds: true }) })} · {t('targets.last', { time: formatTime(tgt.lastSeen, { seconds: true }) })}
                  </div>
                </div>
                <span className="shrink-0 text-redlog-text-dim text-xs">{t('targets.events', { count: tgt.eventCount })}</span>
              </div>

              {open && (
                <div className="ml-9 mr-4 mb-3 border-l-2 border-redlog-border pl-3 space-y-1 py-1">
                  {evidence.length === 0 ? (
                    <p className="text-redlog-text-faint text-xs">{t('targets.noEvidence')}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {Object.entries(
                          evidence.reduce<Record<string, number>>((acc, e) => {
                            acc[e.agentType] = (acc[e.agentType] || 0) + 1
                            return acc
                          }, {})
                        ).map(([type, count]) => (
                          <span key={type} className="text-xs text-redlog-text-dim bg-redlog-elevated px-1.5 py-0.5 rounded">
                            {type}: {count}
                          </span>
                        ))}
                      </div>
                      <p className="text-redlog-text-dim text-xs mb-1">
                        {t('targets.loaded', { loaded: evidence.length, total: tgt.eventCount })}
                      </p>
                      {evidence.map((e) => (
                        <div key={e.id} className="flex items-start gap-2 text-xs">
                          <span className="w-16 shrink-0 truncate text-redlog-text-faint" title={agentTypeLabel(e.agentType, t)}>{agentTypeLabel(e.agentType, t)}</span>
                          <span className="text-redlog-text-faint w-16 shrink-0">
                            {formatTime(e.timestamp, { seconds: true })}
                          </span>
                          {/* The same one-line title the Timeline and the Reader give this
                              event, in the interface language: a type with no row of its
                              own here (HTTP, DNS, a plugin's) is named, not dumped as JSON. */}
                          <span title={eventTitle(e, t)} className="text-redlog-text truncate">{eventTitle(e, t)}</span>
                        </div>
                      ))}
                      {hasMore && (
                        <Button size="compact" level="quiet" className="mt-2"
                          onClick={loadMore}
                          disabled={loadingMore}
                        >
                          {loadingMore ? t('targets.loading') : t('targets.loadMore', { loaded: evidence.length, total: tgt.eventCount })}
                        </Button>
                      )}
                    </>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    {activeTarget === tgt.target ? (
                      <span className="text-xs text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">{t('targets.viewingThis')}</span>
                    ) : (
                      <Button size="compact" data-testid="target-work-on" onClick={() => { void window.redlog.targetContext.set(tgt.target) }}>{t('activeTarget.workOn')}</Button>
                    )}
                    {onOpenInTimeline && (
                      <Button size="compact" data-testid="target-locate" onClick={() => { setTargetId(tgt.target); onOpenInTimeline(tgt.lastSeen) }}>{t('targets.openInTimeline')}</Button>
                    )}
                    {tgt.inScope === false && (
                      <Button size="compact" data-testid="target-add-to-scope" onClick={() => { void addToScope(tgt) }}>{t('targets.addToScope')}</Button>
                    )}
                  </div>
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}
        {filtered.length > 0 && <div className="border-t border-redlog-border px-4 py-2.5 text-xs text-redlog-text-faint">{t('targets.shownCount', { shown: filtered.length, total: targets.length })}</div>}
      </div>
      <p className="text-xs text-redlog-text-dim">{t('targets.hint')}</p>
    </div></div>
  )
}
