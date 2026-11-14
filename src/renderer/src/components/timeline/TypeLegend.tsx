// The key to the event-type glyphs: a toolbar button that opens one glyph and
// one name per type present in the loaded events. It explains symbols; it does
// not change what is shown (that is the filter bar). Types are told apart by
// glyph and name, not colour — lanes are all `lane` grey (UIUX-STANDARD §1) —
// and every card carries its glyph and type name without the legend open.

import { LANES, LANE_LABEL_KEYS, type LaneId } from '../../lib/timelineDomain'
import { ToolbarPopover } from './ToolbarPopover'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export const LANE_GLYPHS: Record<LaneId, string> = {
  shell: '$', agent: '✦', http_navigation: '↔', scanner: '⌖', browser: '◫', dns: '@',
  pivot: '⤳', screenshot: '▣', file_transfer: '⇅', credential_use: '⚿',
  c2_checkin: '◎', marker: '⚑', loot: '◆', cleanup: '✕', scope: '⊘', process: '▸', system: '⚙'
}

export function TypeLegend({ lanes, t, buttonClassName }: { lanes: ReadonlySet<LaneId>; t: Translate; buttonClassName: string }): JSX.Element | null {
  const present = LANES.filter((l) => lanes.has(l))
  // One kind of event has nothing to be told apart from.
  if (present.length < 2) return null
  return (
    <ToolbarPopover
      label={t('timeline.legend.button')}
      buttonTestId="timeline-legend-button"
      panelTestId="log-lane-legend"
      panelLabel={t('timeline.log.legend')}
      buttonClassName={buttonClassName}
      panelClassName="w-48 px-3 py-2"
    >
      <ul aria-label={t('timeline.log.legend')} className="flex flex-col gap-1 text-xs text-redlog-text-dim">
        {present.map((lane) => (
          <li key={lane} className="flex items-center gap-2">
            <span aria-hidden="true" className="w-3 text-center shrink-0 text-redlog-lane">{LANE_GLYPHS[lane]}</span>
            <span>{t(LANE_LABEL_KEYS[lane])}</span>
          </li>
        ))}
      </ul>
    </ToolbarPopover>
  )
}
