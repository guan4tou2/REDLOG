import { useState, type ReactNode, type RefObject } from 'react'
import { Button } from '../Button'
import { TimeRangeFields } from '../TimeRangeFields'
import { HighlightInput } from './TimelineStatusStrips'
import { formatTime } from '../../lib/time'
import type { TimeRange } from '../../lib/FilterContext'
import type { TimelineMode } from '../../lib/timelineMode'

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

const chip = (active: boolean): string =>
  `px-2 h-6 text-xs whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-red-400 ${active ? 'bg-redlog-elevated text-redlog-text font-medium' : 'text-redlog-text-dim hover:text-redlog-text'}`

const ghost = 'px-2 h-6 text-xs whitespace-nowrap rounded border border-redlog-border text-redlog-text-dim hover:text-redlog-text transition-colors focus-visible:outline focus-visible:outline-red-400'

/** Stitch 05's two rows. Row 1 chooses what is drawn (the shared time range
 *  and the zoom); row 2 says where the operator is and switches the reading.
 *  It renders what it is given: the panel owns every value, and the follow
 *  badge and the ⋯ menu come in as slots because they close over panel state. */
export function TimelineToolbar({
  t, timeRange, setTimeRange, hasMore, loadedCount, loadedSpanMs, projectSpanMs, total, onRetryTotal, onLoadMore,
  zoom, onZoomOut, onZoomIn, onResetZoom, anchorTs,
  mode, onModeChange, onOpenActivity,
  filterQuery, onFilterQueryChange, searchInputRef,
  onHelp, moreMenu, followBadge
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
  onOpenActivity?: () => void
  filterQuery: string
  onFilterQueryChange: (v: string) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  onHelp: () => void
  moreMenu: ReactNode
  followBadge: ReactNode
}): JSX.Element {
  const [customOpen, setCustomOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-redlog-text-dim">{t('timeline.range.label')}</span>
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
              className="w-6 h-6 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:text-redlog-text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
              title={t('timeline.zoomOut')}
              aria-label={t('timeline.zoomOut')}
            >−</button>
            <span data-testid="timeline-zoom-level" className="px-1 text-xs text-redlog-text-faint font-mono tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={onZoomIn}
              className="w-6 h-6 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
              title={t('timeline.zoomIn')}
              aria-label={t('timeline.zoomIn')}
            >+</button>
            <button
              type="button"
              onClick={onResetZoom}
              data-testid="timeline-zoom-reset"
              disabled={Math.abs(zoom - 1) < 0.01}
              className="px-1.5 h-6 text-xs text-redlog-text-dim hover:text-redlog-text disabled:cursor-default disabled:opacity-50 disabled:hover:text-redlog-text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim rounded"
            >{t('timeline.resetZoom')}</button>
          </div>
        </div>
        <div className="ml-auto shrink-0 flex items-center gap-1">
          {/* v0.9.3 U2: keyboard-shortcut cheatsheet. Every hotkey was
              invisible without prior knowledge; the modal lists them all. */}
          <button
            type="button"
            onClick={onHelp}
            className="w-6 h-6 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.help.title')}
            aria-label={t('timeline.help.title')}
          >?</button>
          {moreMenu}
        </div>
      </div>

      {customOpen && (
        <div data-testid="timeline-range-custom-fields" className="flex flex-wrap items-end gap-2">
          <TimeRangeFields timeRange={timeRange} setTimeRange={setTimeRange} testIdPrefix="timeline-time" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-redlog-text-faint">
          <span>{t('timeline.anchor.label')}</span>
          <span data-testid="timeline-anchor" className="font-mono tabular-nums text-redlog-text">
            {anchorTs != null ? formatTime(anchorTs, { seconds: true }) : '—'}
          </span>
          {/* FR-003: while older admitted rows exist, the line says how many
              are drawn of how many there are. N counts the rows held, M the
              rows the same filter admits; a total that failed says so. "Total"
              is claimed only when nothing older is left to load. */}
          <span aria-hidden="true">/</span>
          <span data-testid="timeline-range-status" className="font-mono tabular-nums whitespace-nowrap">
            {!hasMore
              ? t('timeline.events', { count: loadedCount })
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
        </div>
        <div role="group" aria-label={t('timeline.mode.label')} className="flex items-center rounded border border-redlog-border overflow-hidden">
          {(['standard', 'lanes'] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`timeline-mode-${m}`}
              aria-pressed={mode === m}
              onClick={() => onModeChange(m)}
              className={chip(mode === m)}
            >{t(`timeline.mode.${m}`)}</button>
          ))}
        </div>
        {onOpenActivity && (
          <button type="button" data-testid="timeline-open-activity" onClick={onOpenActivity} className={ghost}>{t('sidebar.search')}</button>
        )}
        {/* v0.6.91 W1: the `/` highlight box. The input stays mounted so `/`
            and ⌘F can focus it; it is only drawn while it is open, has text,
            or has focus. */}
        <button
          type="button"
          data-testid="timeline-search-toggle"
          aria-expanded={showSearch}
          onClick={() => { setSearchOpen(true); searchInputRef.current?.focus() }}
          className={ghost}
        >{t('timeline.searchRange')}</button>
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
        {followBadge}
      </div>
    </div>
  )
}
