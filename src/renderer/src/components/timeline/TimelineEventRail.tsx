// The Timeline's card rail (Stitch 05): the events of the current window as a
// vertical rail of cards, oldest at the top like the time axis above it. One
// card is one event; what a card shows comes from `buildCard` and nothing
// else. Folds, the per-row tier badge, operator, amend count and the exit
// result moved here from the old list row unchanged in meaning.
//
// Cards deliberately do NOT carry `data-timeline-event`: the ruler's dots own
// the single roving tab stop, and a card is reached by its own tabIndex.

import { useEffect, useMemo, useState } from 'react'
import { foldByCause, statusSummary } from '../../lib/timelineFold'
import { buildCard } from '../../lib/timelineCard'
import type { RedLogEvent } from '../../../../core/db/event-types'
import { LANE_COLORS, type PluginEventType } from '../../lib/timelineDomain'
import { TierBadge } from '../TierBadge'
import { LANE_GLYPHS } from './TypeLegend'

type Translate = (key: string, vars?: Record<string, string | number>) => string

interface CardShared {
  selectedId: string | null
  pluginTypes: PluginEventType[]
  showOperator: boolean
  operatorLabel: (id: string) => string
  titleOf: (e: RedLogEvent) => string
  amendSuffix: (e: RedLogEvent) => string
  amendCountOf: (id: string) => number | undefined
  /** A click: `detail` is the click count (0 for the keyboard), so the second
   *  click of a double-click is not read as a second selection toggle. */
  onSelect: (e: RedLogEvent, detail: number) => void
  /** Double-click opens the detail body; Enter toggles it. */
  onOpen: (e: RedLogEvent, how: 'dblclick' | 'key') => void
  t: Translate
}

/** The rail's own spine: a dot on a line, left of every card. */
function Spine({ lane, selected }: { lane: keyof typeof LANE_COLORS; selected: boolean }): JSX.Element {
  return (
    <span aria-hidden="true" className="relative w-4 shrink-0 flex justify-center">
      <span className="absolute inset-y-0 w-px bg-redlog-border/60" />
      <span
        className={`relative mt-2.5 w-2 h-2 rounded-full ${selected ? 'ring-2 ring-red-400/70' : ''}`}
        style={{ backgroundColor: LANE_COLORS[lane] }}
      />
    </span>
  )
}

function RailCard({ evt, nested, shared }: { evt: RedLogEvent; nested: boolean; shared: CardShared }): JSX.Element {
  const { selectedId, pluginTypes, showOperator, operatorLabel, titleOf, amendSuffix, amendCountOf, onSelect, onOpen, t } = shared
  const isSel = selectedId === evt.id
  // The summary grows the card, which moves every card below it. Held back
  // until the selection has been still for a double-click's length, so the
  // second click of a double-click lands where the first one did.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!isSel) { setSettled(false); return }
    const timer = setTimeout(() => setSettled(true), 400)
    return () => clearTimeout(timer)
  }, [isSel])
  const card = buildCard(evt, { t, titleOf, pluginTypes, withStdout: isSel && settled })
  const amended = amendCountOf(evt.id)
  return (
    <div className={`flex ${nested ? 'pl-8 pr-4' : 'px-4'}`}>
      <Spine lane={card.lane} selected={isSel} />
      <div
        data-testid="rail-card"
        className={`flex-1 min-w-0 my-0.5 ml-1 px-2.5 py-1 rounded border cursor-pointer transition-colors text-xs focus-visible:outline focus-visible:outline-red-400 ${
          isSel ? 'bg-redlog-elevated/50 border-redlog-border' : 'border-redlog-border-subtle/40 hover:bg-redlog-elevated/20'
        }`}
        role="button"
        tabIndex={0}
        aria-pressed={isSel}
        onClick={(e) => onSelect(evt, e.detail)}
        onDoubleClick={() => onOpen(evt, 'dblclick')}
        onKeyDown={(e) => {
          // The standard Timeline is read from this rail, so a card has to be
          // reachable and selectable without a pointer: Space selects, Enter opens.
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOpen(evt, 'key') }
          else if (e.key === ' ') { e.preventDefault(); onSelect(evt, 0) }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-redlog-text-faint font-mono tabular-nums shrink-0">{card.time}</span>
          {/* v0.14 §9.1: per-row tier badge, icon-only to keep the card light;
              the labelled version lives in the detail panel. */}
          <TierBadge tier={evt.tier} variant="row" />
          <span data-testid="rail-card-tag" className="shrink-0 px-1.5 rounded border border-redlog-border-subtle/60 text-redlog-text-dim">
            <span aria-hidden="true" className="text-redlog-lane mr-1">{LANE_GLYPHS[card.lane]}</span>{card.typeTag}
          </span>
          {showOperator && (
            <span className="text-redlog-text-dim font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
              {operatorLabel(evt.operatorId)}
            </span>
          )}
          <span title={`${card.title}${amendSuffix(evt)}`} className="text-redlog-text truncate">{card.title}</span>
          {/* Only for a marker that HAS been corrected (§22). Never truncated,
              and never in danger red: an ordinary correction must not read as
              an alarm. */}
          {amended !== undefined && (
            <span
              data-testid="marker-amend-count"
              className="text-redlog-text-dim font-mono tabular-nums shrink-0"
              title={t('marker.amendedTimesHint')}
            >
              {t('marker.amendedTimes', { count: amended })}
            </span>
          )}
          {card.meta.length > 0 && (
            <span data-testid="rail-card-meta" className="ml-auto shrink-0 font-mono tabular-nums text-redlog-text-faint">
              {card.meta.map((m, i) => (
                <span key={i} className={evt.data?.subtype === 'command_end' && i === 0 && typeof evt.data.exit_code === 'number' && evt.data.exit_code !== 0 ? 'text-amber-400' : ''}>
                  {i > 0 ? ' · ' : ''}{m}
                </span>
              ))}
            </span>
          )}
        </div>
        {card.detail && (
          <p data-testid="rail-card-detail" title={card.detail} className="mt-0.5 text-redlog-text-faint truncate">{card.detail}</p>
        )}
        {card.stdout && (
          <div data-testid="rail-card-stdout" className="mt-1 rounded bg-redlog-bg/60 px-2 py-1">
            <p className="text-redlog-text-faint">{t('timeline.card.stdout')}</p>
            <pre className="font-mono text-redlog-text-dim whitespace-pre-wrap break-all">{card.stdout}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

export function TimelineEventRail({
  events, annotatedIds, ...shared
}: CardShared & {
  /** Oldest first. */
  events: readonly RedLogEvent[]
  /** Events carrying an operator note; those never fold. */
  annotatedIds?: ReadonlySet<string>
}): JSX.Element {
  const { selectedId, titleOf, t } = shared
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
  return (
    <>
      {rows.map((row) => {
        if (row.kind !== 'fold') return <RailCard key={row.event.id} evt={row.event} nested={false} shared={shared} />
        const { parent, children } = row.fold
        const open = expanded.has(parent.id)
        return (
          <div key={parent.id}>
            <div
              data-testid={`log-fold-${parent.id}`}
              className="flex items-center gap-2 px-4 py-1 cursor-pointer text-xs hover:bg-redlog-elevated/20"
              onClick={() => toggle(parent.id)}
            >
              <span className="text-redlog-text-faint shrink-0 w-4 text-center">{open ? '▾' : '▸'}</span>
              <span className="text-redlog-text-faint font-mono tabular-nums shrink-0">
                {buildCard(parent, { t, titleOf, pluginTypes: shared.pluginTypes }).time}
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
            {/* The basis, named. A fold is the app asserting these requests
                came from that command, and a reader is entitled to know what
                it is asserting it from — here, the socket's owning process,
                which is recorded rather than inferred. */}
            {open && (
              <p className="px-4 py-1 text-xs text-redlog-text-faint">{t('timeline.fold.basis')}</p>
            )}
            {open && children.map((c) => <RailCard key={c.id} evt={c} nested shared={shared} />)}
          </div>
        )
      })}
    </>
  )
}
