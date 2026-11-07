// The swim-lane panel's header (Stitch 05, "多軌並行泳道"): what the panel is,
// how many lanes have events, which span the ruler covers, and the way back to
// the standard view. It sits outside `timeline-lane-scroll`: that scroller's
// first child is the label column, and the geometry suite reads its rows.

import { formatTime } from '../../lib/time'
import { toLane, type LaneId, type PluginEventType } from '../../lib/timelineDomain'
import type { RedLogEvent } from '../../../../core/db/event-types'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Rows per lane among the LOADED events. Never a project total. */
export function countByLane(
  events: readonly RedLogEvent[],
  pluginTypes: PluginEventType[]
): ReadonlyMap<LaneId, number> {
  const counts = new Map<LaneId, number>()
  for (const e of events) {
    const lane = toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)
    counts.set(lane, (counts.get(lane) ?? 0) + 1)
  }
  return counts
}

/** "(42 筆)" for a lane. While older pages are unfetched the number is a floor,
 *  so it carries a `+` instead of claiming a total. */
export function laneCountText(count: number, partial: boolean, t: Translate): string {
  return t(partial ? 'timeline.lanes.rowCountPartial' : 'timeline.lanes.rowCount', { count })
}

/** The header's two statements: how many lanes have events, and the span the
 *  ruler draws. The span is the loaded range, and says so while older pages
 *  are still unfetched. Null when nothing is loaded. */
export function lanesHeaderText(
  args: { activeLanes: number; start: number; end: number; partial: boolean },
  t: Translate
): { active: string; span: string | null } {
  const { activeLanes, start, end, partial } = args
  const span = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? t(partial ? 'timeline.lanes.loadedRange' : 'timeline.lanes.range', {
        from: formatTime(start, { seconds: true }),
        to: formatTime(end, { seconds: true })
      })
    : null
  return { active: t('timeline.lanes.active', { count: activeLanes }), span }
}

export function TimelineLanesHeader({
  activeLanes, start, end, partial, onCollapse, t
}: {
  activeLanes: number
  start: number
  end: number
  partial: boolean
  onCollapse: () => void
  t: Translate
}): JSX.Element {
  const { active, span } = lanesHeaderText({ activeLanes, start, end, partial }, t)
  return (
    <div
      data-testid="timeline-lanes-header"
      className="shrink-0 flex items-center justify-between gap-3 px-4 py-1.5 border-b border-redlog-border/60 bg-redlog-surface/60 text-xs"
    >
      <div className="min-w-0 flex items-baseline gap-x-3 gap-y-0.5 flex-wrap">
        <span className="text-redlog-text">{t('timeline.lanes.title')}</span>
        <span data-testid="timeline-lanes-active" className="text-redlog-text-dim">{active}</span>
        {span && <span data-testid="timeline-lanes-span" className="text-redlog-text-faint font-mono tabular-nums">{span}</span>}
      </div>
      <button
        data-testid="timeline-lanes-collapse"
        onClick={onCollapse}
        className="shrink-0 px-2 py-0.5 rounded border border-redlog-border/60 text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
      >
        {t('timeline.lanes.collapse')}
      </button>
    </div>
  )
}
