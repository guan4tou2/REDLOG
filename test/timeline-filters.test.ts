import { describe, it, expect } from 'vitest'
import {
  buildSearchIndex,
  computeFilterMatches,
  computeTargetMatches,
  computeScopeMatches
} from '../src/renderer/src/lib/timelineFilters'
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
