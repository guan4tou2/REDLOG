// The Timeline's bottom region: the card rail (TimelineEventRail) under its
// header, plus the two strips only this region can say. Moved out of
// Timeline.tsx (UI/UX audit F13) with every value it shows passed in; the
// panel still owns selection and the events themselves.

import type { RedLogEvent } from '../../../../core/db/event-types'
import type { PluginEventType } from '../../lib/timelineDomain'
import { isMac, isWindows } from '../../lib/platform'
import { TimelineEventRail } from './TimelineEventRail'

/** Why this host answers nothing, in its own terms. The three platforms fail
 *  at different points and the remedy is not the same, so a line that lists
 *  all three tells two operators out of three to go install something they do
 *  not need — and said nothing at all to the Windows one, which is how this
 *  was reported. `netstat -no` is always present, so on Windows the socket's
 *  owner is never the missing half: the pid → command link is. */
const blindCauseKey = isWindows
  ? 'timeline.fold.blind.win32'
  : isMac ? 'timeline.fold.blind.darwin' : 'timeline.fold.blind.linux'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function TimelineEventLog({
  events, selectedId, detailOpen, pluginTypes, showOperator, operatorLabel,
  titleOf, amendSuffix, amendCountOf, onSelect, onOpen, t, heightPx, rootRef, total,
  hiddenByQuery = 0, showingAll = false, onToggleHidden, annotatedIds, attributionBlind = false,
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
  /** Traffic has been seen and the command join has resolved none of it —
   *  a capability this host does not have, not a fact about the engagement. */
  attributionBlind?: boolean
  /** Swim-lane mode hides the list (Stitch 05); what only this component can
   *  say stays: the hidden-by-query toggle and the attribution-blind line. */
  stripsOnly?: boolean
}): JSX.Element | null {
  // vh until the operator drags, so the DEFAULT scales with window height —
  // ~5 rows at 900px tall, ~8 at 1200 — rather than freezing a pixel count
  // taken on somebody else's monitor. Once dragged, px wins.
  // A FLOOR, not a fixed height. The lanes above are capped at their content,
  // so whatever the window has left over arrives here — which is the point:
  // the surplus used to be spent padding lanes out around a 9px dot while
  // this list showed six rows.
  if (stripsOnly) {
    const hiddenToggle = (hiddenByQuery > 0 || showingAll) && onToggleHidden
    if (!hiddenToggle && !attributionBlind) return null
    return (
      <div className="shrink-0 border-t border-redlog-border/60 bg-redlog-bg/50">
        {hiddenToggle && (
          <div className="px-4 py-1.5 flex justify-end">
            <button
              data-testid="log-hidden-toggle"
              onClick={onToggleHidden}
              className="text-xs text-redlog-text-faint hover:text-redlog-text underline decoration-dotted"
            >
              {showingAll
                ? t('timeline.log.onlyMatches')
                : t('timeline.log.hiddenByQuery', { count: hiddenByQuery })}
            </button>
          </div>
        )}
        {attributionBlind && (
          <p data-testid="log-attribution-blind" className="px-4 py-1 text-xs text-redlog-warn">
            {t('timeline.fold.blind')} {t(blindCauseKey)}
          </p>
        )}
      </div>
    )
  }
  const minHeight = heightPx != null ? `${heightPx}px` : (selectedId ? '18vh' : '22vh')
  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col border-t border-redlog-border/60 bg-redlog-bg/50" style={{ minHeight }}>
      <div className="shrink-0 px-4 py-1.5 border-b border-redlog-border/40 flex items-center justify-end gap-2">
        {/* The view title already names this region (Timeline.tsx); the band
            header carries only what it uniquely has: the hidden count and the
            number of rows. */}
        <>
          {/* The count is never not shown. A filter that hides without saying
              how much is a filter that loses evidence quietly — and the thing
              that mattered is sometimes a stack trace inside a 404 body that
              no query would have matched. */}
          {(hiddenByQuery > 0 || showingAll) && onToggleHidden && (
            <button
              data-testid="log-hidden-toggle"
              onClick={onToggleHidden}
              className="text-xs text-redlog-text-faint hover:text-redlog-text underline decoration-dotted"
            >
              {showingAll
                ? t('timeline.log.onlyMatches')
                : t('timeline.log.hiddenByQuery', { count: hiddenByQuery })}
            </button>
          )}
          <span data-testid="rail-count" className="text-xs text-redlog-text-faint font-mono tabular-nums">
            {total !== undefined && total > events.length
              ? t('timeline.rail.capped', { shown: events.length, total })
              : events.length}
          </span>
        </>
      </div>
      {/* The header above is a fixed row; this takes the rest. It used to
          restate the vh literal in a calc(), which is why only the default
          height ever lined up. */}
      {/* Nothing folded, and the reason is not "nothing was caused".
          Without this line a host that cannot answer who owns a socket looks
          exactly like an engagement where every request stood alone — which
          is how the join below sat broken for a year — and the next person to
          notice is tempted to put the time-window guess back. */}
      {attributionBlind && (
        <p data-testid="log-attribution-blind" className="shrink-0 px-4 py-1 text-xs text-redlog-warn border-b border-redlog-border-subtle/30">
          {t('timeline.fold.blind')} {t(blindCauseKey)}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TimelineEventRail
          events={events} annotatedIds={annotatedIds} selectedId={selectedId} pluginTypes={pluginTypes}
          showOperator={showOperator} operatorLabel={operatorLabel} titleOf={titleOf} amendSuffix={amendSuffix}
          amendCountOf={amendCountOf} onSelect={onSelect} onOpen={onOpen} t={t}
        />
      </div>
    </div>
  )
}
