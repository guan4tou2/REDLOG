import { useState, type ReactNode, type RefObject } from 'react'
import { Button } from '../Button'
import { TimeRangeFields } from '../TimeRangeFields'
import { HighlightInput } from './TimelineStatusStrips'
import { AttributionStatus } from './AttributionStatus'
import { TypeLegend } from './TypeLegend'
import { formatTime } from '../../lib/time'
import type { TimeRange } from '../../lib/FilterContext'
import type { TimelineMode } from '../../lib/timelineMode'
import type { LaneId } from '../../lib/timelineDomain'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export type TimelineTotal = { state: 'pending' } | { state: 'ok'; value: number } | { state: 'failed' }

const HOUR = 3600_000

/** "25h 07m" for the loaded span. Only for ranges of at least a minute. */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

// 28 CSS px, the compact Button's floor (UIUX §4): 24 rendered at 21.6 device
// px under `body { zoom: 0.9 }`.
const chip = (active: boolean): string =>
  `px-2 h-7 text-xs whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-red-400 ${active ? 'bg-redlog-elevated text-redlog-text font-medium' : 'text-redlog-text-dim hover:text-redlog-text'}`

const ghost = 'px-2 h-7 text-xs whitespace-nowrap rounded border border-redlog-border text-redlog-text-dim hover:text-redlog-text transition-colors focus-visible:outline focus-visible:outline-red-400'

const menuRow = 'w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs font-mono text-redlog-text hover:bg-white/5 disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent'

/** A shortcut, drawn beside the menu item it triggers. The item carries it as
 *  `aria-keyshortcuts`, so it is not read twice. */
function Kbd({ k }: { k: string }): JSX.Element {
  return <kbd aria-hidden="true" className="font-mono text-xs text-redlog-text-faint">{k}</kbd>
}

/** One row (2026-11-14): what is drawn (range, zoom), how much of it is loaded,
 *  where the operator is (live), what the page cannot answer (attribution),
 *  the key to its symbols, and 更多 for everything set once or reached by a
 *  shortcut — the mode, the `/` highlight, reset zoom and the shortcut list.
 *  It renders what it is given: the panel owns every value, and the follow
 *  badge and the panel's own view toggles come in as slots. */
export function TimelineToolbar({
  t, timeRange, setTimeRange, hasMore, loadedCount, loadedSpanMs, projectSpanMs, total, onRetryTotal, onLoadMore,
  zoom, onZoomOut, onZoomIn, onResetZoom, anchorTs,
  mode, onModeChange,
  filterQuery, onFilterQueryChange, searchInputRef,
  onHelp, attributionBlind, lanes, moreItems, followBadge
}: {
  t: Translate
  timeRange: TimeRange | null
  setTimeRange: (range: TimeRange | null) => void
  hasMore: boolean
  loadedCount: number
  /** Last minus first loaded timestamp, or null with fewer than two rows. */
  loadedSpanMs: number | null
  /** First to last row across the project, from `events:span`; null when unknown. */
  projectSpanMs: number | null
  total: TimelineTotal
  onRetryTotal: () => void
  onLoadMore: () => void
  zoom: number
  onZoomOut: () => void
  onZoomIn: () => void
  onResetZoom: () => void
  anchorTs: number | null
  mode: TimelineMode
  onModeChange: (mode: TimelineMode) => void
  filterQuery: string
  onFilterQueryChange: (v: string) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  onHelp: () => void
  /** Traffic arrived and the command join resolved none of it. */
  attributionBlind: boolean
  /** Event types among the loaded rows, for the legend. */
  lanes: ReadonlySet<LaneId>
  /** The panel's own view toggles, drawn inside 更多. */
  moreItems: ReactNode
  followBadge: ReactNode
}): JSX.Element {
  const [customOpen, setCustomOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const since = timeRange?.since
  const isLastHour = since != null && timeRange?.before == null
    && Date.now() - since < HOUR * 1.1 && Date.now() - since > HOUR * 0.5
  const isAll = !timeRange
  const isCustom = !!timeRange && !isLastHour
  // The project's span comes from `events:span`. Without it (pending or
  // failed) the loaded rows are the project only once nothing older is left.
  const spanMs = projectSpanMs ?? (!hasMore ? loadedSpanMs : null)
  const showSpan = isAll && spanMs != null && spanMs >= 60_000
  const showSearch = searchOpen || filterQuery !== ''

  return (
    <div data-testid="timeline-toolbar" className="shrink-0 border-b border-redlog-border/80 px-4 py-1.5 flex flex-col gap-1.5">
      <div data-testid="timeline-toolbar-row" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div role="group" aria-label={t('timeline.range.label')} className="flex items-center rounded border border-redlog-border overflow-hidden">
          <button
            type="button"
            data-testid="timeline-range-last1h"
            aria-pressed={isLastHour}
            title={t('filter.presetIsSnapshot')}
            onClick={() => { setCustomOpen(false); setTimeRange({ since: Date.now() - HOUR }) }}
            className={chip(isLastHour)}
          >{t('timeline.range.last1h')}</button>
          <button
            type="button"
            data-testid="timeline-range-all"
            aria-pressed={isAll}
            onClick={() => { setCustomOpen(false); setTimeRange(null) }}
            className={chip(isAll)}
          >{t('timeline.range.all')}{showSpan ? ` (${formatSpan(spanMs as number)})` : ''}</button>
          <button
            type="button"
            data-testid="timeline-range-custom"
            aria-pressed={isCustom || customOpen}
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
            className={chip(isCustom || customOpen)}
          >{t('timeline.range.custom')}</button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onZoomOut}
            // 100% is the whole span; there is nothing further out to show.
            disabled={zoom <= 1.001}
            className="w-7 h-7 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:text-redlog-text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.zoomOut')}
            aria-label={t('timeline.zoomOut')}
          >−</button>
          <span data-testid="timeline-zoom-level" className="px-1 text-xs text-redlog-text-faint font-mono tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={onZoomIn}
            className="w-7 h-7 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.zoomIn')}
            aria-label={t('timeline.zoomIn')}
          >+</button>
        </div>
        {/* FR-003: the page's one count. While older admitted rows exist it
            says how many are drawn of how many there are: N counts the rows
            held, M the rows the same filter admits; a total that failed says
            so. With nothing older to load it says "loaded", not "total": the
            Timeline leaves out RedLog's own housekeeping rows, which the status
            bar's count of recorded events includes. */}
        <span data-testid="timeline-range-status" className="text-xs text-redlog-text-faint font-mono tabular-nums whitespace-nowrap">
          {!hasMore
            ? t('timeline.loadedEvents', { count: loadedCount })
            : total.state === 'ok'
              ? t('timeline.rangeOfTotal', { shown: loadedCount, total: total.value })
              : total.state === 'pending'
                ? t('timeline.rangeTotalPending', { shown: loadedCount })
                : (
                  <>
                    {t('timeline.totalUnavailable', { shown: loadedCount })}{' '}
                    <button
                      type="button"
                      data-testid="timeline-total-retry"
                      onClick={onRetryTotal}
                      className="underline hover:text-redlog-text"
                    >{t('common.retry')}</button>
                  </>
                )}
        </span>
        {hasMore && (
          <Button size="compact" level="quiet" onClick={onLoadMore}>
            {t('timeline.loadMore')}
          </Button>
        )}
        {anchorTs != null && (
          <span className="flex items-center gap-1.5 text-xs text-redlog-text-faint whitespace-nowrap">
            <span>{t('timeline.anchor.label')}</span>
            <span data-testid="timeline-anchor" className="font-mono tabular-nums text-redlog-text">{formatTime(anchorTs, { seconds: true })}</span>
          </span>
        )}
        {/* v0.6.91 W1: the `/` highlight box. The input stays mounted so `/`
            and ⌘F can focus it; it is only drawn while it is open, has text,
            or has focus. 更多 ▸ 搜尋區間 opens it too. */}
        <div className={showSearch ? '' : 'sr-only'}>
          <HighlightInput
            value={filterQuery}
            onChange={onFilterQueryChange}
            inputRef={searchInputRef}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            t={t}
          />
        </div>
        <div className="ml-auto shrink-0 flex items-center gap-2">
          <AttributionStatus blind={attributionBlind} t={t} />
          <TypeLegend lanes={lanes} t={t} buttonClassName={ghost} />
          {followBadge}
          <div
            className="relative shrink-0"
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !moreOpen) return
              e.preventDefault()
              e.stopPropagation()
              setMoreOpen(false)
              ;(e.currentTarget.querySelector('[data-testid="timeline-more-menu"]') as HTMLElement | null)?.focus()
            }}
          >
            <button
              type="button"
              data-testid="timeline-more-menu"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className="whitespace-nowrap text-xs px-1.5 py-0.5 min-h-7 rounded font-mono text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            >⋯ {t('timeline.more.button')}</button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div role="menu" data-testid="timeline-more-panel" className="absolute top-full right-0 mt-1 z-40 w-56 rounded border border-redlog-border bg-redlog-surface/95 shadow-xl py-1">
                  {/* The reading is chosen once and remembered per project;
                      the swim lanes' own header folds back to standard. */}
                  <div role="group" aria-label={t('timeline.mode.label')}>
                    {(['standard', 'lanes'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="menuitemradio"
                        data-testid={`timeline-mode-${m}`}
                        aria-checked={mode === m}
                        onClick={() => { setMoreOpen(false); onModeChange(m) }}
                        className={menuRow}
                      >
                        <span>{t(`timeline.mode.${m}`)}</span>
                        <span className={mode === m ? 'text-redlog-cyan' : 'text-redlog-text-faint'}>{mode === m ? '✓' : ''}</span>
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-redlog-border/50 my-0.5" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="timeline-search-toggle"
                    aria-keyshortcuts="/"
                    onClick={() => { setMoreOpen(false); setSearchOpen(true); searchInputRef.current?.focus() }}
                    className={menuRow}
                  >
                    <span>{t('timeline.searchRange')}</span>
                    <Kbd k="/" />
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="timeline-zoom-reset"
                    aria-keyshortcuts="0"
                    disabled={Math.abs(zoom - 1) < 0.01}
                    onClick={() => { setMoreOpen(false); onResetZoom() }}
                    className={menuRow}
                  >
                    <span>{t('timeline.resetZoom')}</span>
                    <Kbd k="0" />
                  </button>
                  <div className="border-t border-redlog-border/50 my-0.5" />
                  {moreItems}
                  <div className="border-t border-redlog-border/50 my-0.5" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="timeline-help-open"
                    aria-keyshortcuts="?"
                    onClick={() => { setMoreOpen(false); onHelp() }}
                    className={menuRow}
                  >
                    <span>{t('timeline.help.title')}</span>
                    <Kbd k="?" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {customOpen && (
        <div data-testid="timeline-range-custom-fields" className="flex flex-wrap items-end gap-2">
          <TimeRangeFields timeRange={timeRange} setTimeRange={setTimeRange} testIdPrefix="timeline-time" />
        </div>
      )}
    </div>
  )
}
