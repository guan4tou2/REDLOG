import { describe, it, expect } from 'vitest'
import {
  mapMatchesToDrawn,
  distributeLaneEvents,
  distributeRowEvents,
  computeRecentEvents,
  computeSliceCount,
  type ViewportWindow
} from '../src/renderer/src/lib/timelineFilters'
import { toLane, type LaneId } from '../src/renderer/src/lib/timelineDomain'
import type { RedLogEvent } from '../src/core/db/event-types'

function evt(
  id: string,
  agentType: string,
  data: Record<string, unknown> = {},
  extra: Partial<RedLogEvent> = {}
): RedLogEvent {
  return {
    id,
    timestamp: Date.now(),
    engagementId: 'eng-1',
    sessionId: 'ses-1',
    operatorId: 'op-1',
    agentType,
    hostname: 'localhost',
    sourceIP: null,
    targetId: null,
    data,
    hash: 'h',
    prevHash: null,
    createdAt: Date.now(),
    ...extra
  }
}

// Spec 038: which rows match is the query layer's answer (events:matchIds);
// this only decides how a match on a folded-away row is shown.
describe('mapMatchesToDrawn', () => {
  it('lights a drawn row that matched, and nothing else', () => {
    const a = evt('a', 'dns'); const b = evt('b', 'dns')
    expect([...mapMatchesToDrawn(new Set(['a']), [a, b], [a, b]).lit]).toEqual(['a'])
  })

  it('lights the drawn end of a command whose hidden start matched', () => {
    const start = evt('s', 'shell', { subtype: 'command_start', command: 'nmap x', pid: 3 })
    const end = evt('e', 'shell', { subtype: 'command_end', command: 'nmap x', pid: 3 })
    expect([...mapMatchesToDrawn(new Set(['s']), [start, end], [end]).lit]).toEqual(['e'])
  })

  it('lights the session row of a collapsed agent turn, or counts it as hidden', () => {
    const turn = evt('t', 'agent', { subtype: 'tool_call', session_id: 'S1' })
    const snap = evt('n', 'agent', { subtype: 'transcript_snapshot', session_id: 'S1' })
    expect(mapMatchesToDrawn(new Set(['t']), [turn, snap], [snap])).toEqual({ lit: new Set(['n']), hiddenByCollapse: 0 })
    expect(mapMatchesToDrawn(new Set(['t']), [turn], [])).toEqual({ lit: new Set(), hiddenByCollapse: 1 })
  })

  it('lights a marker when its drawn amendment matched', () => {
    const marker = evt('m', 'marker', { title: 'old' })
    const amendment = evt('x', 'marker', { subtype: 'amended', markerId: 'm', title: 'new' })
    expect([...mapMatchesToDrawn(new Set(['x']), [marker, amendment], [marker, amendment]).lit].sort()).toEqual(['m', 'x'])
  })
})

describe('distributeLaneEvents', () => {
  it('distributes events into their correct lanes', () => {
    const events = [
      evt('a', 'shell', { command: 'ls' }),
      evt('b', 'scanner', { url: 'http://x' }),
      evt('c', 'shell', { command: 'pwd' }),
      evt('d', 'marker', { title: 'note' })
    ]
    const lanes = distributeLaneEvents(events, undefined)
    expect(lanes.shell.map((e) => e.id)).toEqual(['a', 'c'])
    expect(lanes.scanner.map((e) => e.id)).toEqual(['b'])
    expect(lanes.marker.map((e) => e.id)).toEqual(['d'])
    expect(lanes.dns).toEqual([])
  })
})

describe('distributeRowEvents', () => {
  it('groups events by visible rows', () => {
    const events = [
      evt('a', 'shell'),
      evt('b', 'dns'),
      evt('c', 'marker')
    ]
    const visible = ['shell', 'dns', 'marker']
    const collapsed = new Set<string>()
    const result = distributeRowEvents(events, visible, collapsed, undefined, new Set())
    expect(result['shell'].map((e) => e.id)).toEqual(['a'])
    expect(result['dns'].map((e) => e.id)).toEqual(['b'])
    expect(result['marker'].map((e) => e.id)).toEqual(['c'])
  })

  it('collapses bands into a single row', () => {
    const events = [
      evt('a', 'shell'),
      evt('b', 'agent')
    ]
    const visible = ['commands']
    const collapsed = new Set(['commands'])
    const result = distributeRowEvents(events, visible, collapsed, undefined, new Set())
    expect(result['commands'].map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('drops events from hidden lanes', () => {
    const events = [
      evt('a', 'shell'),
      evt('b', 'dns')
    ]
    const visible = ['shell']
    const collapsed = new Set<string>()
    const result = distributeRowEvents(events, visible, collapsed, undefined, new Set(['dns']))
    expect(result['shell'].map((e) => e.id)).toEqual(['a'])
    expect(result['dns']).toBeUndefined()
  })

  // Collapsing a band must not resurrect a lane the operator hid: the band row
  // absorbs its lanes' events, so without the hidden-lane check the hide would
  // silently undo itself the moment the band was collapsed.
  it('keeps a hidden lane hidden when its band is collapsed', () => {
    const events = [evt('a', 'shell'), evt('b', 'agent')]
    const result = distributeRowEvents(events, ['commands'], new Set(['commands']), undefined, new Set(['agent']))
    expect(result['commands'].map((e) => e.id)).toEqual(['a'])
  })
})

function makeVp(overrides: Partial<ViewportWindow> = {}): ViewportWindow {
  return {
    left: 0,
    width: 100,
    trackW: 1000,
    fromX: (px) => px,
    displayTs: (e) => e.timestamp,
    timeSpan: 1000,
    ...overrides
  }
}

describe('computeRecentEvents', () => {
  it('returns up to cap events newest-first when whole track visible', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      evt(`e${i}`, 'shell', {}, { timestamp: 100 + i })
    )
    const result = computeRecentEvents(events, new Set<LaneId>(), undefined, makeVp(), 5)
    expect(result.length).toBe(5)
    expect(result[0].id).toBe('e9')
    expect(result[4].id).toBe('e5')
  })

  it('excludes hidden lanes', () => {
    const events = [
      evt('a', 'shell', {}, { timestamp: 200 }),
      evt('b', 'dns', {}, { timestamp: 100 })
    ]
    const hidden = new Set<LaneId>(['dns' as LaneId])
    const result = computeRecentEvents(events, hidden, undefined, makeVp())
    expect(result.map((e) => e.id)).toEqual(['a'])
  })

  it('returns only in-viewport events when scrolled', () => {
    const events = [
      evt('a', 'shell', {}, { timestamp: 100 }),
      evt('b', 'shell', {}, { timestamp: 500 }),
      evt('c', 'shell', {}, { timestamp: 900 })
    ]
    const vp = makeVp({ left: 40, width: 30, fromX: (px) => px })
    const result = computeRecentEvents(events, new Set<LaneId>(), undefined, vp)
    expect(result.map((e) => e.id)).toEqual(['b'])
  })

  it('falls back to nearest when viewport is empty', () => {
    const events = [
      evt('a', 'shell', {}, { timestamp: 100 }),
      evt('b', 'shell', {}, { timestamp: 200 })
    ]
    const vp = makeVp({ left: 80, width: 10, fromX: (px) => px })
    const result = computeRecentEvents(events, new Set<LaneId>(), undefined, vp)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].id).toBe('b')
  })
})

describe('computeSliceCount', () => {
  it('returns total count when whole track visible', () => {
    const events = [evt('a', 'shell'), evt('b', 'dns')]
    expect(computeSliceCount(events, makeVp())).toBe(2)
  })

  it('counts only in-viewport events when scrolled', () => {
    const events = [
      evt('a', 'shell', {}, { timestamp: 100 }),
      evt('b', 'shell', {}, { timestamp: 500 }),
      evt('c', 'shell', {}, { timestamp: 900 })
    ]
    const vp = makeVp({ left: 40, width: 30, fromX: (px) => px })
    expect(computeSliceCount(events, vp)).toBe(1)
  })
})

// The `/` search used to DIM non-matches and leave them in place. That is not
// a filter on a half-screen window beside a terminal: a dirb run puts 920
// rows in the list and all 920 keep their space, so searching `backup` left
// the operator scrolling the same distance looking for a shade of grey.
describe('computeRecentEvents under a / search', () => {
  const vp = makeVp()

  it('shows only the matches', () => {
    const events = [evt('a', 'shell'), evt('b', 'shell'), evt('c', 'shell')]
    const matched = new Set([events[0].id, events[2].id])
    const rows = computeRecentEvents(events, new Set<LaneId>(), undefined, vp, 50, matched)
    expect(rows.map((e) => e.id).sort()).toEqual([events[0].id, events[2].id].sort())
  })

  it('shows everything when there is no query', () => {
    const events = [evt('a', 'shell'), evt('b', 'shell')]
    expect(computeRecentEvents(events, new Set<LaneId>(), undefined, vp, 50, null)).toHaveLength(2)
  })

  it('shows nothing rather than everything when a query matches nothing', () => {
    // Falling back to the unfiltered list would read as "these all match".
    const events = [evt('a', 'shell'), evt('b', 'shell')]
    expect(computeRecentEvents(events, new Set<LaneId>(), undefined, vp, 50, new Set())).toHaveLength(0)
  })

  it('still honours a hidden lane — the two filters compose', () => {
    const shell = evt('a', 'shell')
    const http = evt('b', 'http_navigation')
    const matched = new Set([shell.id, http.id])
    const hidden = new Set<LaneId>([toLane('http_navigation', undefined, undefined)])
    const rows = computeRecentEvents([shell, http], hidden, undefined, vp, 50, matched)
    expect(rows.map((e) => e.id)).toEqual([shell.id])
  })
})
