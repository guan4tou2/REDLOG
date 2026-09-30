// The Timeline's bottom list: the recent events, newest first, one row each.
// Moved out of Timeline.tsx (UI/UX audit F13) with every value it shows passed
// in; the panel still owns selection and the events themselves.

import { formatTime } from '../../lib/time'
import { LANE_COLORS, toLane, type PluginEventType } from '../../lib/timelineDomain'
import { TierBadge } from '../TierBadge'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function TimelineEventLog({
  events, selectedId, detailOpen, pluginTypes, showOperator, operatorLabel,
  titleOf, amendSuffix, amendCountOf, onSelect, t, heightPx, rootRef
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
}): JSX.Element {
  // vh until the operator drags, so the DEFAULT scales with window height —
  // ~5 rows at 900px tall, ~8 at 1200 — rather than freezing a pixel count
  // taken on somebody else's monitor. Once dragged, px wins.
  const height = heightPx != null ? `${heightPx}px` : (selectedId ? '18vh' : '22vh')
  return (
    <div ref={rootRef} className="shrink-0 border-t border-redlog-border/60 bg-redlog-bg/50" style={{ height }}>
      <div className="px-3 py-1.5 border-b border-redlog-border/40 flex items-center justify-between">
        <span className="text-xs text-redlog-text-dim font-mono uppercase tracking-wider">{t('timeline.title')}</span>
        <span className="text-xs text-redlog-text-faint font-mono tabular-nums">{events.length}</span>
      </div>
      {/* 32px is the header above. Expressed against the panel's own height so
          the list follows a dragged size; it used to restate the vh literal,
          which is why only the default ever lined up. */}
      <div className="overflow-y-auto" style={{ height: 'calc(100% - 32px)' }}>
        {events.map((evt) => {
          const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)
          const isSel = selectedId === evt.id
          const amended = amendCountOf(evt.id)
          return (
            <div
              key={evt.id}
              className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors text-xs border-b border-redlog-border-subtle/30 ${
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
        })}
      </div>
    </div>
  )
}
