// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TypeLegend, LANE_GLYPHS } from '../src/renderer/src/components/timeline/TypeLegend'
import { LANES, type LaneId } from '../src/renderer/src/lib/timelineDomain'

const t = (k: string): string => k
afterEach(cleanup)

// 2026-11-14: the legend is a toolbar button that opens a popover, not a strip
// above the track. It explains symbols; the filter bar changes what is shown.
const draw = (lanes: LaneId[]): void => {
  render(<TypeLegend lanes={new Set<LaneId>(lanes)} t={t} buttonClassName="" />)
}

describe('TypeLegend', () => {
  it('is closed until asked, then names only the lanes that are present, in lane order', () => {
    draw(['screenshot', 'shell'])
    expect(screen.queryByTestId('log-lane-legend')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-legend-button'))
    const legend = screen.getByTestId('log-lane-legend')
    const items = legend.querySelectorAll('li')
    expect([...items].map((li) => li.textContent)).toEqual([`${LANE_GLYPHS.shell}timeline.shell`, `${LANE_GLYPHS.screenshot}timeline.screenshot`])
    expect(legend.textContent).not.toContain('timeline.dns')
    // The click-and-double-click sentence lives in the help (timeline.help.selectDot).
    expect(legend.textContent).not.toContain('timeline.legend.hint')
  })

  it('draws no button for one kind of event', () => {
    draw(['shell'])
    expect(screen.queryByTestId('timeline-legend-button')).toBeNull()
  })

  it('tells types apart by glyph, never by a per-type colour', () => {
    draw([...LANES])
    fireEvent.click(screen.getByTestId('timeline-legend-button'))
    const html = screen.getByTestId('log-lane-legend').innerHTML
    expect(html).not.toMatch(/style=|bg-(red|cyan|green|blue|amber|indigo)|text-(red|cyan|green|blue|amber|indigo)-/)
    expect(new Set(LANES.map((l) => LANE_GLYPHS[l])).size).toBe(LANES.length)
  })
})
