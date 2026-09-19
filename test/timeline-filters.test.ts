import { describe, it, expect } from 'vitest'
import {
  buildSearchIndex,
  computeFilterMatches,
  computeTargetMatches,
  computeScopeMatches,
  computePaletteResults,
  distributeLaneEvents,
  distributeRowEvents,
  computeRecentEvents,
  computeSliceCount,
  type ViewportWindow
} from '../src/renderer/src/lib/timelineFilters'
import type { LaneId } from '../src/renderer/src/lib/timelineDomain'
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

describe('buildSearchIndex', () => {
  it('returns empty map when query is blank', () => {
    const events = [evt('a', 'shell', { command: 'whoami' })]
    expect(buildSearchIndex(events, {}, '').size).toBe(0)
    expect(buildSearchIndex(events, {}, '   ').size).toBe(0)
  })

  it('indexes command, url, host, title, subtype, operatorId, eventTitle', () => {
    const events = [evt('a', 'shell', { command: 'nmap -sV' })]
    const idx = buildSearchIndex(events, {}, 'x')
    const bag = idx.get('a')!
    expect(bag).toContain('nmap -sv')
  })

  it('includes operator display name in bag', () => {
    const events = [evt('a', 'shell', { command: 'ls' })]
    const idx = buildSearchIndex(events, { 'op-1': 'Alice' }, 'x')
    const bag = idx.get('a')!
    expect(bag).toContain('alice')
  })

  it('includes folded marker title for amended markers', () => {
    const events = [
      evt('m1', 'marker', { title: 'SQLi found', severity: 'high' }),
      evt('m2', 'marker', { subtype: 'amended', markerId: 'm1', title: 'SQLi confirmed' })
    ]
    const idx = buildSearchIndex(events, {}, 'x')
    const bag = idx.get('m1')!
    expect(bag).toContain('sqli confirmed')
  })
})

describe('computeFilterMatches', () => {
  it('returns null when query is blank', () => {
    const idx = new Map([['a', 'hello world']])
    expect(computeFilterMatches(idx, '')).toBeNull()
    expect(computeFilterMatches(idx, '  ')).toBeNull()
  })

  it('returns matching event ids', () => {
    const idx = new Map([
      ['a', 'nmap -sv target'],
      ['b', 'curl http://example.com'],
      ['c', 'ls -la']
    ])
    const result = computeFilterMatches(idx, 'nmap')!
    expect(result.size).toBe(1)
    expect(result.has('a')).toBe(true)
  })

  it('is case-insensitive', () => {
    const idx = new Map([['a', 'nmap scan']])
    const result = computeFilterMatches(idx, 'NMAP')!
    expect(result.has('a')).toBe(true)
  })
})

describe('computeTargetMatches', () => {
  it('returns null when no target', () => {
    expect(computeTargetMatches([evt('a', 'shell')], null)).toBeNull()
    expect(computeTargetMatches([evt('a', 'shell')], '')).toBeNull()
  })

  it('matches by targetId', () => {
    const events = [evt('a', 'shell', {}, { targetId: '10.0.20.15' })]
    const result = computeTargetMatches(events, '10.0.20.15')!
    expect(result.has('a')).toBe(true)
  })

  it('matches by data.host', () => {
    const events = [evt('a', 'scanner', { host: 'web01.internal' })]
    const result = computeTargetMatches(events, 'web01.internal')!
    expect(result.has('a')).toBe(true)
  })

  it('matches by data.dest_ip', () => {
    const events = [evt('a', 'dns', { dest_ip: '192.168.1.1' })]
    const result = computeTargetMatches(events, '192.168.1.1')!
    expect(result.has('a')).toBe(true)
  })

  it('is case-insensitive', () => {
    const events = [evt('a', 'scanner', { host: 'Web01.Internal' })]
    const result = computeTargetMatches(events, 'web01.internal')!
    expect(result.has('a')).toBe(true)
  })

  it('excludes non-matching events', () => {
    const events = [
      evt('a', 'shell', {}, { targetId: '10.0.20.15' }),
      evt('b', 'shell', {}, { targetId: '10.0.20.16' })
    ]
    const result = computeTargetMatches(events, '10.0.20.15')!
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(false)
  })
})

describe('computeScopeMatches', () => {
  it('returns null when inScopeOnly is false', () => {
    const events = [evt('a', 'shell', {}, { targetId: '10.0.20.15' })]
    expect(computeScopeMatches(events, ['10.0.20.0/24'], false)).toBeNull()
  })

  it('returns null when scopeTargets is empty', () => {
    const events = [evt('a', 'shell', {}, { targetId: '10.0.20.15' })]
    expect(computeScopeMatches(events, [], true)).toBeNull()
  })

  it('includes events without targetId', () => {
    const events = [evt('a', 'system')]
    const result = computeScopeMatches(events, ['10.0.20.15'], true)!
    expect(result.has('a')).toBe(true)
  })

  it('includes events matching scope pattern', () => {
    const events = [evt('a', 'shell', {}, { targetId: '10.0.20.15' })]
    const result = computeScopeMatches(events, ['10.0.20.15'], true)!
    expect(result.has('a')).toBe(true)
  })

  it('excludes out-of-scope events', () => {
    const events = [evt('a', 'shell', {}, { targetId: '192.168.1.1' })]
    const result = computeScopeMatches(events, ['10.0.20.15'], true)!
    expect(result.has('a')).toBe(false)
  })
})

describe('computePaletteResults', () => {
  const titleFn = (e: RedLogEvent) => {
    const d = e.data as Record<string, unknown> | undefined
    return String(d?.title ?? d?.command ?? e.agentType)
  }

  it('returns empty when query is blank', () => {
    const events = [evt('a', 'shell', { command: 'whoami' })]
    expect(computePaletteResults(events, {}, '', titleFn)).toEqual([])
    expect(computePaletteResults(events, {}, '  ', titleFn)).toEqual([])
  })

  it('matches events by command field', () => {
    const events = [
      evt('a', 'shell', { command: 'nmap -sV 10.0.0.1' }),
      evt('b', 'shell', { command: 'ls -la' })
    ]
    const results = computePaletteResults(events, {}, 'nmap', titleFn)
    expect(results.length).toBe(1)
    expect(results[0].kind).toBe('event')
    expect('event' in results[0] && results[0].event.id).toBe('a')
  })

  it('matches operators by name and id', () => {
    const events = [evt('a', 'shell')]
    const results = computePaletteResults(events, { 'op-1': 'Alice' }, 'alice', titleFn)
    const opItems = results.filter((r) => r.kind === 'operator')
    expect(opItems.length).toBe(1)
    expect(opItems[0].label).toBe('Alice')
  })

  it('matches distinct hosts', () => {
    const events = [
      evt('a', 'scanner', { host: 'web01.internal' }),
      evt('b', 'scanner', { host: 'web01.internal' })
    ]
    const results = computePaletteResults(events, {}, 'web01', titleFn)
    const hostItems = results.filter((r) => r.kind === 'host')
    expect(hostItems.length).toBe(1)
    expect(hostItems[0].label).toBe('web01.internal')
  })

  it('caps results at 20', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      evt(`e${i}`, 'shell', { command: `cmd${i}` })
    )
    const results = computePaletteResults(events, {}, 'cmd', titleFn)
    expect(results.length).toBe(20)
  })

  it('sorts by score descending, then timestamp descending', () => {
    const events = [
      evt('a', 'shell', { command: 'abc' }),
      evt('b', 'shell', { command: 'abcdef' })
    ]
    const results = computePaletteResults(events, {}, 'abc', titleFn)
    expect(results.length).toBe(2)
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
    const result = distributeRowEvents(events, visible, collapsed, undefined)
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
    const result = distributeRowEvents(events, visible, collapsed, undefined)
    expect(result['commands'].map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('drops events from hidden lanes', () => {
    const events = [
      evt('a', 'shell'),
      evt('b', 'dns')
    ]
    const visible = ['shell']
    const collapsed = new Set<string>()
    const result = distributeRowEvents(events, visible, collapsed, undefined)
    expect(result['shell'].map((e) => e.id)).toEqual(['a'])
    expect(result['dns']).toBeUndefined()
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
