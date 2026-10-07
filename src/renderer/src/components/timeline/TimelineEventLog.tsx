// The Timeline's bottom list: the recent events, newest first, one row each.
// Moved out of Timeline.tsx (UI/UX audit F13) with every value it shows passed
// in; the panel still owns selection and the events themselves.

import { useMemo, useState } from 'react'
import { formatTime } from '../../lib/time'
import { foldByCause, statusSummary } from '../../lib/timelineFold'
import type { RedLogEvent } from '../../../../core/db/event-types'
import { LANE_COLORS, toLane, type PluginEventType } from '../../lib/timelineDomain'
import { isMac, isWindows } from '../../lib/platform'
import { TierBadge } from '../TierBadge'

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
  titleOf, amendSuffix, amendCountOf, onSelect, t, heightPx, rootRef,
  hiddenByQuery = 0, showingAll = false, onToggleHidden, annotatedIds, attributionBlind = false
}: {
  events: readonly RedLogEvent[]
  selectedId: string | null
  detailOpen: boolean
  pluginTypes: PluginEventType[]
  showOperator: boolean
  operatorLabel: (id: string) => string
  titleOf: (e: RedLogEvent) => string
  amendSuffix: (e: RedLogEvent) => string
  /** How many times a marker was amended; undefined for one never corrected. */
  amendCountOf: (id: string) => number | undefined
  /** Toggle: the same row again clears the selection. */
  onSelect: (e: RedLogEvent) => void
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
}): JSX.Element {
  // Folds start closed and the operator opens the ones they want. Expansion
  // is per parent and not remembered across a filter change: the row they
  // opened may not even be in the next result.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string): void => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const rows = useMemo(
    () => foldByCause(events, { annotated: annotatedIds, selected: selectedId }),
    [events, annotatedIds, selectedId]
  )
  // vh until the operator drags, so the DEFAULT scales with window height —
  // ~5 rows at 900px tall, ~8 at 1200 — rather than freezing a pixel count
  // taken on somebody else's monitor. Once dragged, px wins.
  // A FLOOR, not a fixed height. The lanes above are capped at their content,
  // so whatever the window has left over arrives here — which is the point:
  // the surplus used to be spent padding lanes out around a 9px dot while
  // this list showed six rows.
  const minHeight = heightPx != null ? `${heightPx}px` : (selectedId ? '18vh' : '22vh')
  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col border-t border-redlog-border/60 bg-redlog-bg/50" style={{ minHeight }}>
      <div className="shrink-0 px-4 py-1.5 border-b border-redlog-border/40 flex items-center justify-between">
        <span className="text-xs text-redlog-text-dim font-mono uppercase tracking-wider">{t('timeline.title')}</span>
        <span className="flex items-center gap-2">
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
          <span className="text-xs text-redlog-text-faint font-mono tabular-nums">{events.length}</span>
        </span>
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
        {rows.map((row) => {
          if (row.kind === 'fold') {
            const { parent, children } = row.fold
            const open = expanded.has(parent.id)
            return (
              <div key={parent.id}>
                <div
                  data-testid={`log-fold-${parent.id}`}
                  className="flex items-center gap-2 px-4 py-1 cursor-pointer text-xs border-b border-redlog-border-subtle/30 hover:bg-redlog-elevated/20"
                  onClick={() => toggle(parent.id)}
                >
                  <span className="text-redlog-text-faint shrink-0 w-1.5">{open ? '▾' : '▸'}</span>
                  <span className="text-redlog-text-faint font-mono tabular-nums shrink-0 w-16">
                    {formatTime(parent.timestamp, { seconds: true })}
                  </span>
                  <span title={titleOf(parent)} className="text-redlog-text truncate">{titleOf(parent)}</span>
                  <span className="ml-auto flex items-center gap-2 shrink-0 font-mono text-redlog-text-faint">
                    {/* The statuses, not just a total. 904 of the 920 are 404s
                        nobody wants to read; what the operator came for is
                        whether anything answered 200. */}
                    {statusSummary(children).slice(0, 3).map(({ status, count }) => (
                      <span key={status} className={status >= 200 && status < 300 ? 'text-redlog-safe' : ''}>
                        {status}&times;{count}
                      </span>
                    ))}
                    <span>{t('timeline.fold.count', { count: children.length })}</span>
                  </span>
                </div>
                {/* The basis, named. A fold is the app asserting these
                    requests came from that command, and a reader is entitled
                    to know what it is asserting it from — here, the socket's
                    owning process, which is recorded rather than inferred. */}
                {open && (
                  <p className="px-4 py-1 text-xs text-redlog-text-faint border-b border-redlog-border-subtle/30">
                    {t('timeline.fold.basis')}
                  </p>
                )}
                {open && children.map((c) => eventRow(c, true))}
              </div>
            )
          }
          return eventRow(row.event, false)
        })}
      </div>
    </div>
  )

  function eventRow(evt: RedLogEvent, nested: boolean): JSX.Element {
          const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)
          const isSel = selectedId === evt.id
          const amended = amendCountOf(evt.id)
          return (
            <div
              key={evt.id}
              className={`flex items-center gap-2 ${nested ? 'pl-8 pr-4' : 'px-4'} py-1 cursor-pointer transition-colors text-xs border-b border-redlog-border-subtle/30 ${
                isSel ? 'bg-redlog-elevated/50' : 'hover:bg-redlog-elevated/20'
              }`}
              onClick={() => onSelect(evt)}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[lane] }} />
              <span className="text-redlog-text-faint font-mono tabular-nums shrink-0 w-16">
                {formatTime(evt.timestamp, { seconds: true })}
              </span>
              {/* v0.14 §9.1: per-row tier badge, icon-only to keep the row
                  light; the labelled version lives in the detail panel. */}
              <TierBadge tier={evt.tier} variant="row" />
              {showOperator && (
                <span className="text-redlog-text-dim font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
                  {operatorLabel(evt.operatorId)}
                </span>
              )}
              <span title={`${titleOf(evt)}${amendSuffix(evt)}`} className="text-redlog-text-dim truncate">{titleOf(evt)}</span>
              {/* Only for a marker that HAS been corrected (§22). Never
                  truncated, and never in danger red: an ordinary correction
                  must not read as an alarm. */}
              {amended !== undefined && (
                <span
                  data-testid="marker-amend-count"
                  className="text-redlog-text-dim font-mono tabular-nums shrink-0"
                  title={t('marker.amendedTimesHint')}
                >
                  {t('marker.amendedTimes', { count: amended })}
                </span>
              )}
            </div>
          )
  }
}
