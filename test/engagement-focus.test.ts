// Which capture the first-run screen leads with. A host engagement wires a
// shell hook first; a web one wires the proxy first. The default is neither
// preference — it keeps the order the screen has always had.
import { describe, it, expect } from 'vitest'
import { readFocus, stepOrder, isEngagementFocus, ENGAGEMENT_FOCUSES } from '../src/renderer/src/lib/engagementFocus'

describe('engagement focus', () => {
  it('leads a web engagement with HTTP and everything else with the terminal', () => {
    // An operator whose whole assessment is requests and responses was led
    // through wiring a shell hook they may never use, and told by the layout
    // that the thing they came for was the optional part.
    expect(stepOrder('web')).toEqual(['http', 'terminal'])
    expect(stepOrder('terminal')).toEqual(['terminal', 'http'])
    // `both` keeps today's order: the terminal step is the one this screen has
    // just proved, so it is the shortest step out.
    expect(stepOrder('both')).toEqual(['terminal', 'http'])
  })

  it('defaults to both for a project that has never been asked', () => {
    expect(readFocus(null)).toBe('both')
    expect(readFocus({})).toBe('both')
    expect(readFocus({ engagement: {} })).toBe('both')
    expect(readFocus({ engagement: { id: 'e1' } })).toBe('both')
  })

  it('ignores a stale or hand-edited value rather than ordering by garbage', () => {
    expect(readFocus({ engagement: { focus: 'HTTP' } })).toBe('both')
    expect(readFocus({ engagement: { focus: 42 } })).toBe('both')
    expect(readFocus({ engagement: { focus: null } })).toBe('both')
  })

  it('reads back every value it offers', () => {
    for (const f of ENGAGEMENT_FOCUSES) {
      expect(isEngagementFocus(f)).toBe(true)
      expect(readFocus({ engagement: { focus: f } })).toBe(f)
    }
  })
})
