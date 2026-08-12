import { describe, it, expect } from 'vitest'
import { activeModes } from '../src/renderer/src/lib/timelineModes'
import type { TimelineModeState } from '../src/renderer/src/lib/timelineModes'

// The Timeline carries several sticky, non-default modes that each HIDE or
// TRANSFORM events (focus chain, anomaly filter, agent-turn collapse, lane solo,
// hidden lanes, text filter). Left on, they turn the track near-empty and the
// operator — back from a break — has no idea WHY. activeModes derives the
// "Active:" row (DESIGN-TIMELINE-INTERACTION §T3): one dismissible chip per
// non-default mode, in a fixed order, and NOTHING when everything is default so
// the UI can drop the row entirely. Keeping it pure means the exact chip set is
// written down and testable, not tangled into the header render.

const S = (over: Partial<TimelineModeState> = {}): TimelineModeState => ({
  focusActive: false,
  anomalyOnly: false,
  collapseAgentTurns: false,
  soloLane: null,
  hiddenLaneCount: 0,
  filterQuery: '',
  ...over
})

describe('activeModes', () => {
  it('returns [] when every mode is default (no row is drawn)', () => {
    expect(activeModes(S())).toEqual([])
  })

  it('emits a focus chip when the focus chain is on', () => {
    const chips = activeModes(S({ focusActive: true }))
    expect(chips).toHaveLength(1)
    expect(chips[0].id).toBe('focus')
    expect(chips[0].labelKey).toBe('timeline.mode.focus')
    expect(chips[0].clearAction).toBe('clear-focus')
  })

  it('emits an anomaly chip when the anomaly filter is on', () => {
    const chips = activeModes(S({ anomalyOnly: true }))
    expect(chips.map((c) => c.id)).toEqual(['anomaly'])
    expect(chips[0].labelKey).toBe('timeline.mode.anomaly')
    expect(chips[0].clearAction).toBe('clear-anomaly')
  })

  it('emits a collapse-agent chip when agent turns are collapsed', () => {
    const chips = activeModes(S({ collapseAgentTurns: true }))
    expect(chips.map((c) => c.id)).toEqual(['collapse-agent'])
    expect(chips[0].labelKey).toBe('timeline.mode.collapseAgent')
    expect(chips[0].clearAction).toBe('clear-collapse-agent')
  })

  it('emits a solo chip carrying the lane name when a lane is soloed', () => {
    const chips = activeModes(S({ soloLane: 'shell' }))
    expect(chips.map((c) => c.id)).toEqual(['solo'])
    expect(chips[0].value).toBe('shell')
    expect(chips[0].labelKey).toBe('timeline.mode.solo')
    expect(chips[0].clearAction).toBe('clear-solo')
  })

  it('emits a hidden-lanes chip carrying the count when lanes are hidden', () => {
    const chips = activeModes(S({ hiddenLaneCount: 4 }))
    expect(chips.map((c) => c.id)).toEqual(['hidden-lanes'])
    expect(chips[0].value).toBe('4')
    expect(chips[0].labelKey).toBe('timeline.mode.hiddenLanes')
    expect(chips[0].clearAction).toBe('clear-hidden-lanes')
  })

  it('emits a filter chip carrying the query when the text filter is set', () => {
    const chips = activeModes(S({ filterQuery: 'GET /admin' }))
    expect(chips.map((c) => c.id)).toEqual(['filter'])
    expect(chips[0].value).toBe('GET /admin')
    expect(chips[0].labelKey).toBe('timeline.mode.filter')
    expect(chips[0].clearAction).toBe('clear-filter')
  })

  it('solo and hidden-lanes are mutually exclusive — solo wins when both apply', () => {
    // A soloed lane logically hides every other lane, so the hiddenLaneCount is
    // redundant noise while solo is on; the chip row shows the sharper fact.
    const chips = activeModes(S({ soloLane: 'http', hiddenLaneCount: 12 }))
    expect(chips.map((c) => c.id)).toEqual(['solo'])
    expect(chips[0].value).toBe('http')
  })

  it('falls back to hidden-lanes only when no lane is soloed', () => {
    const chips = activeModes(S({ soloLane: null, hiddenLaneCount: 3 }))
    expect(chips.map((c) => c.id)).toEqual(['hidden-lanes'])
  })

  it('follow mode is never a chip — it does not hide data (open-question resolution)', () => {
    // DESIGN-TIMELINE-INTERACTION open question #3: "following" is auto-scroll,
    // not a mode that hides events, so it stays a header toggle. There is no
    // follow field on TimelineModeState precisely to keep it out of this seam.
    expect(activeModes(S())).toEqual([])
  })

  it('holds a fixed order: focus → anomaly → collapse-agent → solo → hidden → filter', () => {
    const chips = activeModes(
      S({
        focusActive: true,
        anomalyOnly: true,
        collapseAgentTurns: true,
        soloLane: 'agent',
        hiddenLaneCount: 9, // suppressed by solo
        filterQuery: 'sqlmap'
      })
    )
    expect(chips.map((c) => c.id)).toEqual([
      'focus',
      'anomaly',
      'collapse-agent',
      'solo',
      'filter'
    ])
  })

  it('preserves that order when solo is absent so hidden-lanes takes the slot', () => {
    const chips = activeModes(
      S({ focusActive: true, hiddenLaneCount: 2, filterQuery: 'x' })
    )
    expect(chips.map((c) => c.id)).toEqual(['focus', 'hidden-lanes', 'filter'])
  })

  it('ignores a whitespace-free empty filter but keeps a real query verbatim', () => {
    expect(activeModes(S({ filterQuery: '' }))).toEqual([])
    const chips = activeModes(S({ filterQuery: '   ' }))
    // A query of only spaces still filters nothing meaningfully, but the seam
    // treats emptiness as strictly '' — spaces are a real (if odd) query.
    expect(chips.map((c) => c.id)).toEqual(['filter'])
    expect(chips[0].value).toBe('   ')
  })
})
