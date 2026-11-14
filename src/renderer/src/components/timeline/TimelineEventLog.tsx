// The Timeline's bottom region: the card rail (TimelineEventRail) under its
// header, plus the two strips only this region can say. Moved out of
// Timeline.tsx (UI/UX audit F13) with every value it shows passed in; the
// panel still owns selection and the events themselves.

import { memo } from 'react'
import type { RedLogEvent } from '../../../../core/db/event-types'
import type { PluginEventType } from '../../lib/timelineDomain'
import { TimelineEventRail } from './TimelineEventRail'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Memoised: the panel re-renders for things the rail does not show (the
 *  toolbar's total, the clock, the filter box's state), and fifty cards are
 *  built again each time it did. */
export const TimelineEventLog = memo(function TimelineEventLog({
  events, selectedId, detailOpen, pluginTypes, showOperator, operatorLabel,
  titleOf, amendSuffix, amendCountOf, onSelect, onOpen, t, heightPx, rootRef, total,
  hiddenByQuery = 0, showingAll = false, onToggleHidden, annotatedIds,
  stripsOnly = false
}: {
  /** The rail's cards, oldest first. */
  events: readonly RedLogEvent[]
  /** Events the window holds in all; the rail shows the newest of them. */
  total?: number
  selectedId: string | null
  detailOpen: boolean
  pluginTypes: PluginEventType[]
  showOperator: boolean
  operatorLabel: (id: string) => string
  titleOf: (e: RedLogEvent) => string
  amendSuffix: (e: RedLogEvent) => string
  /** How many times a marker was amended; undefined for one never corrected. */
  amendCountOf: (id: string) => number | undefined
  /** One click selects; the same card clicked again clears it. */
  onSelect: (e: RedLogEvent, detail: number) => void
  /** Double-click on a card opens the detail body; Enter toggles it. */
  onOpen: (e: RedLogEvent, how: 'dblclick' | 'key') => void
  t: Translate
  /** Height the operator dragged to, or null for the vh default. */
  heightPx?: number | null
  rootRef?: React.RefObject<HTMLDivElement | null>
  /** Rows the `/` search removed from this window. */
  hiddenByQuery?: number
  showingAll?: boolean
  onToggleHidden?: () => void
  /** Events carrying an operator note; those never fold. */
  annotatedIds?: ReadonlySet<string>
  /** Swim-lane mode hides the list (Stitch 05); what only this component can
   *  say stays: the hidden-by-query toggle. (The attribution warning lives in
   *  the toolbar, in both modes.) */
  stripsOnly?: boolean
}): JSX.Element | null {
  // vh until the operator drags, so the DEFAULT scales with window height —
  // ~5 rows at 900px tall, ~8 at 1200 — rather than freezing a pixel count
  // taken on somebody else's monitor. Once dragged, px wins.
  // A FLOOR, not a fixed height. The lanes above are capped at their content,
  // so whatever the window has left over arrives here — which is the point:
  // the surplus used to be spent padding lanes out around a 9px dot while
  // this list showed six rows.
  const hiddenToggle = (hiddenByQuery > 0 || showingAll) && onToggleHidden
    ? (
      <button
        data-testid="log-hidden-toggle"
        onClick={onToggleHidden}
        className="text-xs text-redlog-text-faint hover:text-redlog-text underline decoration-dotted"
      >
        {showingAll
          ? t('timeline.log.onlyMatches')
          : t('timeline.log.hiddenByQuery', { count: hiddenByQuery })}
      </button>
    )
    : null
  if (stripsOnly) {
    if (!hiddenToggle) return null
    return (
      <div className="shrink-0 border-t border-redlog-border/60 bg-redlog-bg/50 px-4 py-1.5 flex justify-end">
        {hiddenToggle}
      </div>
    )
  }
  const minHeight = heightPx != null ? `${heightPx}px` : (selectedId ? '18vh' : '22vh')
  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col border-t border-redlog-border/60 bg-redlog-bg/50" style={{ minHeight }}>
      {/* The count is never not shown. A filter that hides without saying
          how much is a filter that loses evidence quietly — and the thing that
          mattered is sometimes a stack trace inside a 404 body that no query
          would have matched. The row exists only while it has that to say:
          the number of cards is not repeated here, the toolbar's count is the
          page's one count (2026-11-14). */}
      {hiddenToggle && (
        <div className="shrink-0 px-4 py-1.5 border-b border-redlog-border/40 flex items-center justify-end">
          {hiddenToggle}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The rail draws the newest of the window's events; when the
            window holds more, say so where the missing (older) ones would be,
            so a capped rail never reads as the whole window. */}
        {total !== undefined && total > events.length && (
          <p data-testid="rail-count" className="px-4 pt-1 text-xs text-redlog-text-faint font-mono tabular-nums">
            {t('timeline.rail.capped', { shown: events.length, total })}
          </p>
        )}
        <TimelineEventRail
          events={events} annotatedIds={annotatedIds} selectedId={selectedId} pluginTypes={pluginTypes}
          showOperator={showOperator} operatorLabel={operatorLabel} titleOf={titleOf} amendSuffix={amendSuffix}
          amendCountOf={amendCountOf} onSelect={onSelect} onOpen={onOpen} t={t}
        />
      </div>
    </div>
  )
})
