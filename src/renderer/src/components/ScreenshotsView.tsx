import { SCROLL_GUTTER } from '../lib/pageLayout'
import { useState, useEffect, useCallback, useMemo, useRef, type HTMLAttributes } from 'react'
import { Image, LayoutList, LayoutGrid, Search } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { LoadingSpinner } from './Feedback'
import { confirm as confirmDialog } from './ConfirmDialog'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { formatWhen, useDisplayZone } from '../lib/time'
import { useI18n } from '../i18n'
import { captureScreenshotWithFeedback } from '../lib/captureScreenshot'
import { Modal } from './Modal'
import { Button, FIELD_FOCUS_RING } from './Button'
import { useLivePagedQuery } from '../hooks/useLivePagedQuery'
import { screenshotSrc } from '../lib/screenshotSrc'

const PAGE_SIZE = 100
const shotKey = (shot: RedLogEvent): string => shot.id
const VIEW_KEY = 'redlog-screenshots-view'
type ViewMode = 'list' | 'grid'

function readViewMode(): ViewMode {
  try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list' } catch { return 'list' }
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

interface ShotActions {
  t: Translate
  triggerLabel: (trigger: string) => string
  thumb: (id: string) => string | undefined
  deleted: (id: string) => boolean
  /** The file could not be read when the thumbnail loaded: found at render, not known from data. */
  unreadable: (id: string) => boolean
  markUnreadable: (id: string) => void
  open: (id: string) => void
  remove: (shot: RedLogEvent) => void
}

function Thumb({ shot, a }: { shot: RedLogEvent; a: ShotActions }): JSX.Element {
  const src = a.thumb(shot.id)
  return <>
    {a.deleted(shot.id) ? (
      <span className="px-1 text-center text-redlog-text-faint text-xs">{a.t('screenshots.deletedKept')}</span>
    ) : src && !a.unreadable(shot.id) ? (
      <img src={src} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" onError={() => a.markUnreadable(shot.id)} />
    ) : (
      // No file to show: the read failed, or the event never carried a path
      // (a screenshot recorded through the API without its file). The box
      // used to print the filename, which read as a broken image.
      <span data-testid="screenshot-unreadable" className="px-1 text-center text-redlog-text-faint text-xs">{a.t('screenshots.imageUnavailable')}</span>
    )}
  </>
}

/** What can be done to one screenshot, in its preview: one click target per
 *  row, so the row itself only opens this. A deleted file keeps its event, so
 *  its hash can still be copied; a file that could not be shown can still be
 *  deleted. */
function ShotActionButtons({ shot, a }: { shot: RedLogEvent; a: ShotActions }): JSX.Element {
  const gone = a.deleted(shot.id)
  const unreadable = a.unreadable(shot.id)
  const sha = typeof shot.data.sha256 === 'string' ? shot.data.sha256 : null
  const filePath = typeof shot.data.filePath === 'string' && shot.data.filePath !== '' ? shot.data.filePath : null
  return <div className="flex flex-wrap items-center justify-center gap-2">
    {!gone && !unreadable && filePath && (
      <Button level="quiet" size="compact" data-testid="screenshot-reveal"
        onClick={async () => {
          const ok = await window.redlog.artifacts.reveal('screenshot', filePath).catch(() => false)
          if (!ok) toast(a.t('artifacts.revealFailed'), { type: 'warning', why: a.t('artifacts.revealFailedWhy') })
        }}>
        {a.t('artifacts.reveal')}
      </Button>
    )}
    {sha && (
      <Button level="quiet" size="compact" data-testid="screenshot-copy-hash"
        onClick={() => { void writeClipboard(sha).then((ok) => ok ? toast(a.t('common.copied'), 'success') : toast(a.t('common.copyFailed'), 'error')) }}>
        {a.t('screenshots.copyHash')}
      </Button>
    )}
    {/* No path, no file: there is nothing for "delete file" to remove. */}
    {!gone && filePath && (
      <Button level="quiet" size="compact" data-testid="screenshot-delete" className="hover:text-red-400" aria-label={a.t('screenshots.deleteTitle')} onClick={() => a.remove(shot)}>
        {a.t('screenshots.deleteFile')}
      </Button>
    )}
  </div>
}

function ShotMeta({ shot, a }: { shot: RedLogEvent; a: ShotActions }): JSX.Element {
  const trigger = a.triggerLabel(String(shot.data.trigger ?? ''))
  const diff = shot.data.diffPercent
  const sha = typeof shot.data.sha256 === 'string' ? shot.data.sha256 : null
  return <div data-testid="screenshot-meta" className="min-w-0 flex flex-col gap-1">
    {/* The time first; the date too when it is not today. */}
    <span data-testid="screenshot-time" className="font-mono text-xs text-redlog-text tabular-nums">{formatWhen(shot.timestamp, { seconds: true })}</span>
    <div className="flex flex-wrap items-center gap-2">
      <span title={(shot.data.filename as string) ?? undefined} className="font-mono text-xs text-redlog-text-dim truncate">{(shot.data.filename as string) ?? ''}</span>
      <span className="rounded border border-redlog-border bg-redlog-elevated px-1.5 text-xs text-redlog-text-dim">{trigger}</span>
      {typeof diff === 'number' && <span className="rounded border border-redlog-border px-1.5 text-xs text-redlog-text-faint">{a.t('screenshots.diff', { pct: diff.toFixed(1) })}</span>}
    </div>
    {/* The recorded hash, as recorded; the note says it is not a check. Only
        an abnormal row is marked, by its thumbnail box ("File deleted · event
        record kept", "Image unavailable"). */}
    {sha && <span data-testid="screenshot-hash" className="font-mono text-xs text-redlog-text-faint" title={`${a.t('screenshots.hashNote')} SHA-256: ${sha}`}>{sha.slice(0, 12)}…</span>}
  </div>
}

/** The row's own props: one click target that opens the preview. */
function openProps(shot: RedLogEvent, a: ShotActions): HTMLAttributes<HTMLDivElement> & { tabIndex: number } {
  // The label replaces the row's text for assistive tech, so it carries the
  // abnormal state the thumbnail box shows.
  const state = a.deleted(shot.id) ? a.t('screenshots.deletedKept')
    : a.unreadable(shot.id) || !screenshotSrc(shot.data) ? a.t('screenshots.imageUnavailable') : null
  const label = a.t('screenshots.itemLabel', { time: formatWhen(shot.timestamp, { seconds: true }) })
  return {
    role: 'button', tabIndex: 0,
    'aria-label': state ? `${label} · ${state}` : label,
    onClick: () => a.open(shot.id),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.open(shot.id) } }
  }
}

const ROW_STATE = (gone: boolean): string => `cursor-pointer hover:bg-redlog-elevated/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 ${gone ? 'opacity-70' : ''}`

function ShotRow({ shot, a }: { shot: RedLogEvent; a: ShotActions }): JSX.Element {
  const gone = a.deleted(shot.id) || a.unreadable(shot.id)
  return <div {...openProps(shot, a)} className={`flex items-center gap-3 rounded border border-redlog-border bg-redlog-surface p-2 ${ROW_STATE(gone)}`}>
    <div className="flex h-[81px] w-[144px] shrink-0 items-center justify-center overflow-hidden rounded border border-redlog-border bg-black/30"><Thumb shot={shot} a={a} /></div>
    <ShotMeta shot={shot} a={a} />
  </div>
}

function ShotCard({ shot, a }: { shot: RedLogEvent; a: ShotActions }): JSX.Element {
  const gone = a.deleted(shot.id) || a.unreadable(shot.id)
  return <div {...openProps(shot, a)} className={`flex flex-col overflow-hidden rounded border border-redlog-border bg-redlog-surface ${ROW_STATE(gone)}`}>
    <div className="flex aspect-video items-center justify-center overflow-hidden bg-black/30"><Thumb shot={shot} a={a} /></div>
    <div className="p-2"><ShotMeta shot={shot} a={a} /></div>
  </div>
}

export function ScreenshotsView(): JSX.Element {
  // Re-render when the display zone changes; the status bar names the zone.
  useDisplayZone()
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [unreadableIds, setUnreadableIds] = useState<Set<string>>(new Set())
  const [triggerFilter, setTriggerFilter] = useState<string | null>(null)
  // What triggers exist, counted over the unfiltered load. A filtered load holds
  // only one trigger, so counting from it would leave no way to leave the filter.
  const [triggerTotals, setTriggerTotals] = useState<Array<[string, number]>>([])
  // The totals are counted from the first unfiltered page; when that page was
  // not everything, every chip is a lower bound and says so.
  const [triggerTotalsPartial, setTriggerTotalsPartial] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<ViewMode>(readViewMode)
  const triggerFilterRef = useRef(triggerFilter)
  triggerFilterRef.current = triggerFilter
  const { t } = useI18n()
  // Trigger ids (manual, periodic…) are stored as-is; they are shown in words.
  const triggerLabel = (trigger: string): string => {
    const key = `screenshots.trigger.${trigger}`
    const label = t(key)
    return label === key ? trigger : label
  }

  const countTriggers = (items: RedLogEvent[]): Array<[string, number]> => {
    const counts = new Map<string, number>()
    for (const s of items) counts.set(String(s.data.trigger ?? ''), (counts.get(String(s.data.trigger ?? '')) ?? 0) + 1)
    return [...counts.entries()].sort((x, y) => y[1] - x[1])
  }

  // One trigger is one question: a reply for the trigger that was chosen
  // before is dropped. A failed read is not "no screenshots": it says so and
  // offers the read again.
  const shotRead = useLivePagedQuery<RedLogEvent>({
    key: JSON.stringify(triggerFilter),
    fetch: async (cursor, signal) => {
      const page = await window.redlog.events.queryScreenshotPage({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        trigger: triggerFilter
      })
      if (!cursor && triggerFilter === null && !signal.cancelled) {
        setTriggerTotals(countTriggers(page.items))
        setTriggerTotalsPartial(page.hasMore)
      }
      return { rows: page.items, nextCursor: page.hasMore ? page.nextCursor : null }
    },
    rowKey: shotKey
  })
  const screenshots = shotRead.rows
  const loading = shotRead.state.phase === 'loading'
  const loadError = shotRead.state.phase === 'failed' ? shotRead.state.error : null
  const { hasMore, loadingMore, loadMore, update: updateShots, moreFailed } = shotRead
  useEffect(() => {
    if (moreFailed) toast(t('screenshots.loadFailed'), { type: 'error', detail: moreFailed.error })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreFailed])

  useEffect(() => {
    return window.redlog.events.onNewBatch((events) => {
      for (const event of events) {
        if (event.agentType === 'screenshot') {
          const tf = triggerFilterRef.current
          if (!tf || event.data?.trigger === tf) {
            updateShots((prev) => {
              if (prev.some((e) => e.id === event.id)) return prev
              return [event, ...prev]
            })
          }
        }
        if (event.agentType === 'system' && event.data?.subtype === 'screenshot_deleted') {
          const causes = event.data?._causes as string[] | undefined
          const src = causes?.[0] || (event.data?.source_event as string | undefined)
          if (src) setDeletedIds((prev) => { const n = new Set(prev); n.add(src); return n })
        }
      }
    })
  }, [updateShots])

  useEffect(() => {
    screenshots.forEach((s) => {
      if (thumbs[s.id]) return
      const src = screenshotSrc(s.data)
      if (!src) return
      setThumbs((prev) => ({ ...prev, [s.id]: src }))
    })
  }, [screenshots, thumbs])

  const chooseMode = (next: ViewMode): void => {
    setMode(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* a remembered view is a convenience */ }
  }

  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => needle
    ? screenshots.filter((s) => [s.data.filename, s.data.sha256, s.data.trigger, triggerLabel(String(s.data.trigger ?? ''))]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)))
    : screenshots, [screenshots, needle]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolves false when the operator cancelled the confirmation. */
  const remove = useCallback(async (s: RedLogEvent): Promise<boolean> => {
    const name = typeof s.data.filename === 'string' && s.data.filename ? s.data.filename : t('screenshots.thisFile')
    const ok = await confirmDialog(t('screenshots.deleteTitle'), t('screenshots.deleteConfirm', { name }), true)
    if (!ok) return false
    const fp = s.data.filePath as string | undefined
    if (!fp) {
      toast(t('screenshots.deleteFailed'), { type: 'error', why: t('screenshots.deleteFailedWhy') })
      return true
    }
    const res = await window.redlog.screenshot.deleteFile(s.id, fp)
    if (res.ok) {
      setDeletedIds((prev) => { const n = new Set(prev); n.add(s.id); return n })
      toast(t('screenshots.deletedToast'), 'success')
    } else {
      toast(t('screenshots.deleteFailed'), { type: 'error', why: t('screenshots.deleteFailedWhy'), detail: res.error })
    }
    return true
  }, [t])

  if (loading) {
    return (
      <LoadingSpinner label={t('common.loading')} />
    )
  }

  const actions: ShotActions = {
    t, triggerLabel,
    thumb: (id) => thumbs[id],
    deleted: (id) => deletedIds.has(id),
    unreadable: (id) => unreadableIds.has(id),
    markUnreadable: (id) => setUnreadableIds((prev) => prev.has(id) ? prev : new Set(prev).add(id)),
    open: (id) => setExpanded(id),
    // The preview closes first, so the confirmation is the only dialog open;
    // cancelling returns to the preview it came from.
    remove: (s) => { setExpanded(null); void remove(s).then((confirmed) => { if (!confirmed) setExpanded(s.id) }) }
  }
  const noShots = screenshots.length === 0 && !hasMore && triggerFilter === null

  return (
    <div className={`p-pad overflow-auto h-full ${SCROLL_GUTTER}`}>
      {loadError && (
        <div data-testid="screenshots-load-error" role="alert" className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div>{t('screenshots.loadFailed')}</div>
          <div className="mt-1 truncate font-mono text-redlog-text-faint" title={loadError}>{loadError}</div>
          <button type="button" onClick={shotRead.retry} className="mt-2 text-red-300 underline hover:text-red-200">
            {t('common.retry')}
          </button>
        </div>
      )}
      {!noShots && (
        <div data-testid="screenshots-toolbar" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded border border-redlog-border bg-redlog-surface p-2">
          {/* The triggers the recorded data has — manual and API are what can
              still occur (ruling 7); old periodic and after-command shots keep
              their label. With one, there is nothing to choose between. A
              chosen filter keeps the row, so it can be left. */}
          {/* A partial first page may hold one trigger while older pages hold
              others, so its chips (marked "+") stay. */}
          {triggerTotals.length > 1 || triggerTotalsPartial || triggerFilter !== null ? <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-redlog-text-faint">{t('screenshots.triggerFilter')}</span>
            {/* "All" has no count: the project's is on the Evidence tab, once. */}
            {[{ id: null as string | null, label: t('screenshots.all'), count: null as string | null },
              ...triggerTotals.map(([id, count]) => ({ id: id as string | null, label: triggerLabel(id), count: triggerTotalsPartial ? `${count}+` : String(count) }))].map((chip) => (
              <button
                key={chip.id ?? 'all'}
                type="button"
                aria-pressed={triggerFilter === chip.id}
                onClick={() => setTriggerFilter(chip.id === null || triggerFilter === chip.id ? null : chip.id)}
                className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                  triggerFilter === chip.id ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                }`}
              >{chip.label}{chip.count !== null && <> <span className="text-redlog-text-faint">&middot;{chip.count}</span></>}</button>
            ))}
          </div> : <span />}
          <div className="flex items-center gap-2">
            <label className="relative">
              <span className="sr-only">{t('screenshots.searchLabel')}</span>
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2 top-1.5 text-redlog-text-faint" />
              <input
                data-testid="screenshots-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('screenshots.searchPlaceholder')}
                className={`w-56 rounded border border-redlog-border bg-redlog-bg py-1 pl-7 pr-2 text-xs text-redlog-text placeholder-redlog-muted focus:border-red-500/40 ${FIELD_FOCUS_RING}`}
              />
            </label>
            <div role="group" aria-label={t('screenshots.viewMode')} className="flex items-center rounded border border-redlog-border bg-redlog-elevated p-0.5">
              <button type="button" data-testid="screenshots-view-list" aria-pressed={mode === 'list'} title={t('screenshots.viewList')} aria-label={t('screenshots.viewList')}
                onClick={() => chooseMode('list')} className={`inline-flex h-6 w-6 items-center justify-center rounded ${mode === 'list' ? 'bg-redlog-surface text-redlog-text' : 'text-redlog-text-faint hover:text-redlog-text'}`}><LayoutList size={14} aria-hidden /></button>
              <button type="button" data-testid="screenshots-view-grid" aria-pressed={mode === 'grid'} title={t('screenshots.viewGrid')} aria-label={t('screenshots.viewGrid')}
                onClick={() => chooseMode('grid')} className={`inline-flex h-6 w-6 items-center justify-center rounded ${mode === 'grid' ? 'bg-redlog-surface text-redlog-text' : 'text-redlog-text-faint hover:text-redlog-text'}`}><LayoutGrid size={14} aria-hidden /></button>
            </div>
          </div>
        </div>
      )}
      {loadError && screenshots.length === 0 ? null : noShots ? (
        <EmptyState
          icon={Image}
          title={t('screenshots.empty')}
          reason={t('screenshots.emptyReason')}
          action={{
            label: t('screenshots.captureNow'),
            onClick: () => { void captureScreenshotWithFeedback(t) },
            // Verify, above the tabs, is the Evidence page's primary.
            level: 'secondary'
          }}
        />
      ) : (
        <>
          {/* A count of its own only when the list is not everything: more to
              load, or a search over what is loaded — counted against the rows
              this view holds, so a live arrival cannot make it "6 of 5". */}
          {(hasMore || needle) && <p data-testid="screenshots-summary" className="mb-2 text-xs text-redlog-text-faint">
            {hasMore ? t('screenshots.summaryMore', { shown: screenshots.length }) : t('screenshots.summary', { shown: visible.length, total: screenshots.length })}
          </p>}
          {needle && hasMore && <p data-testid="screenshots-search-scope" className="mb-2 text-xs text-redlog-text-faint">{t('screenshots.searchLoadedOnly', { count: screenshots.length })}</p>}
          {visible.length === 0 ? (
            <EmptyState
              icon={Image}
              title={t('screenshots.noMatch')}
              reason={t('screenshots.noMatchReason')}
              action={{ label: t('screenshots.clearSearch'), onClick: () => { setQuery(''); setTriggerFilter(null) } }}
            />
          ) : mode === 'grid' ? (
            <div data-testid="screenshot-grid" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2">
              {visible.map((s) => <ShotCard key={s.id} shot={s} a={actions} />)}
            </div>
          ) : (
            <div data-testid="screenshot-list" className="flex flex-col gap-1">
              {visible.map((s) => <ShotRow key={s.id} shot={s} a={actions} />)}
            </div>
          )}
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-3 w-full text-xs text-redlog-cyan hover:text-redlog-text disabled:text-redlog-text-faint py-2"
            >
              {loadingMore ? t('screenshots.loading') : t('screenshots.loadMore')}
            </button>
          )}
        </>
      )}
      {(() => {
        // The lightbox (UI/UX audit F20): what the frame is, not just the
        // pixels — when, why it was taken, its hash — and the neighbours
        // without closing it. A shared Modal, so focus stays in it.
        // Every row opens it, including one whose file is gone or could not be
        // shown: the preview is where that row's actions are.
        const viewable = visible
        const at = expanded ? viewable.findIndex((x) => x.id === expanded) : -1
        const shot = at >= 0 ? viewable[at] : null
        const step = (d: number): void => {
          const next = viewable[at + d]
          if (next) setExpanded(next.id)
        }
        const showsImage = shot && !deletedIds.has(shot.id) && !unreadableIds.has(shot.id) && thumbs[shot.id]
        return (
          <Modal
            open={!!shot}
            onClose={() => setExpanded(null)}
            label={t('screenshots.previewLabel')}
            testId="screenshot-lightbox"
            backdropClassName="fixed inset-0 bg-black/80 z-50 flex items-center justify-center pt-caption"
            panelClassName="flex flex-col items-center gap-2 max-w-[92vw]"
          >
            {shot && (
              <div
                className="flex flex-col items-center gap-2"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
                  if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
                }}
              >
                {showsImage
                  ? <img src={thumbs[shot.id]} alt="" className="max-w-[90vw] max-h-[78vh] object-contain rounded-lg" onError={() => actions.markUnreadable(shot.id)} />
                  : <div className="flex h-48 w-80 items-center justify-center rounded-lg border border-redlog-border bg-black/30"><Thumb shot={shot} a={actions} /></div>}
                <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-redlog-text-dim">
                  <button type="button" onClick={() => step(-1)} disabled={at <= 0} aria-label={t('screenshots.prev')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover disabled:opacity-40">←</button>
                  <span className="font-mono">{formatWhen(shot.timestamp, { seconds: true })}</span>
                  <span>{triggerLabel(String(shot.data.trigger ?? ''))}</span>
                  {typeof shot.data.sha256 === 'string' && (
                    <span className="font-mono text-redlog-text-faint" title={`${t('screenshots.hashNote')} SHA-256: ${shot.data.sha256 as string}`}>{(shot.data.sha256 as string).slice(0, 12)}…</span>
                  )}
                  <span className="text-redlog-text-faint">{at + 1} / {viewable.length}</span>
                  <button type="button" onClick={() => step(1)} disabled={at >= viewable.length - 1} aria-label={t('screenshots.next')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover disabled:opacity-40">→</button>
                  <button type="button" onClick={() => setExpanded(null)} aria-label={t('common.close')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover">{t('common.close')}</button>
                </div>
                <ShotActionButtons shot={shot} a={actions} />
              </div>
            )}
          </Modal>
        )
      })()}
    </div>
  )
}
