// The key under the density strip: one glyph and one name per event type that
// is present in the loaded events. Types are told apart by glyph, not colour —
// lanes are all `lane` grey (UIUX-STANDARD §1).

import { LANES, LANE_LABEL_KEYS, type LaneId } from '../../lib/timelineDomain'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export const LANE_GLYPHS: Record<LaneId, string> = {
  shell: '$', agent: '✦', http_navigation: '↔', scanner: '⌖', browser: '◫', dns: '@',
  pivot: '⤳', screenshot: '▣', clipboard: '❐', file_transfer: '⇅', credential_use: '⚿',
  c2_checkin: '◎', marker: '⚑', loot: '◆', cleanup: '✕', scope: '⊘', process: '▸', system: '⚙'
}

export function TypeLegend({ lanes, t }: { lanes: ReadonlySet<LaneId>; t: Translate }): JSX.Element | null {
  const present = LANES.filter((l) => lanes.has(l))
  // One kind of event has nothing to be told apart from.
  if (present.length < 2) return null
  return (
    <div
      data-testid="log-lane-legend"
      className="shrink-0 flex items-center gap-x-3 px-4 py-1 text-xs text-redlog-text-faint border-b border-redlog-border/60"
    >
      <ul aria-label={t('timeline.log.legend')} className="flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
        {present.map((lane) => (
          <li key={lane} className="flex items-center gap-1">
            <span aria-hidden="true" className="w-3 text-center shrink-0 text-redlog-lane">{LANE_GLYPHS[lane]}</span>
            <span>{t(LANE_LABEL_KEYS[lane])}</span>
          </li>
        ))}
      </ul>
      <span data-testid="log-lane-legend-hint" className="ml-auto shrink-0">{t('timeline.legend.hint')}</span>
    </div>
  )
}
