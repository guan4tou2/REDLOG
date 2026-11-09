// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TypeLegend, LANE_GLYPHS } from '../src/renderer/src/components/timeline/TypeLegend'
import { LANES, type LaneId } from '../src/renderer/src/lib/timelineDomain'

const t = (k: string): string => k
afterEach(cleanup)

describe('TypeLegend', () => {
  it('names only the lanes that are present, in lane order, with the hint', () => {
    render(<TypeLegend lanes={new Set<LaneId>(['screenshot', 'shell'])} t={t} />)
    const legend = screen.getByTestId('log-lane-legend')
    const items = legend.querySelectorAll('li')
    expect([...items].map((li) => li.textContent)).toEqual([`${LANE_GLYPHS.shell}timeline.shell`, `${LANE_GLYPHS.screenshot}timeline.screenshot`])
    expect(legend.textContent).not.toContain('timeline.dns')
    expect(screen.getByTestId('log-lane-legend-hint').textContent).toBe('timeline.legend.hint')
  })

  it('draws nothing for one kind of event', () => {
    render(<TypeLegend lanes={new Set<LaneId>(['shell'])} t={t} />)
    expect(screen.queryByTestId('log-lane-legend')).toBeNull()
  })

  it('tells types apart by glyph, never by a per-type colour', () => {
    render(<TypeLegend lanes={new Set<LaneId>(LANES)} t={t} />)
    const html = screen.getByTestId('log-lane-legend').innerHTML
    expect(html).not.toMatch(/style=|bg-(red|cyan|green|blue|amber|indigo)|text-(red|cyan|green|blue|amber|indigo)-/)
    expect(new Set(LANES.map((l) => LANE_GLYPHS[l])).size).toBe(LANES.length)
  })
})
