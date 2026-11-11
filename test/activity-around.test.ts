import { describe, expect, it } from 'vitest'
import type { ActivitySummary } from '../src/core/activity-contract'
import type { RedLogEvent } from '../src/core/db/events'
import { AROUND_MINUTES, AROUND_PER_SIDE, aroundQueries, aroundRelation, formatOffset, shapeAround } from '../src/renderer/src/lib/activityAround'
import { windowAround } from '../src/renderer/src/lib/timeRangeInput'

const ev = (id: string, timestamp: number, agentType: string, data: Record<string, unknown>, sessionId = 'capture'): RedLogEvent =>
  ({ id, timestamp, engagementId: 'p', sessionId, operatorId: 'op', agentType, hostname: 'h', data } as unknown as RedLogEvent)
const shell = (id: string, ts: number, data: Record<string, unknown> = {}): RedLogEvent => ev(id, ts, 'shell', { shell: 'bash', terminalId: 'term-1', subtype: 'command_end', ...data })
const tool = (id: string, ts: number, data: Record<string, unknown> = {}): RedLogEvent => ev(id, ts, 'agent', { agent: 'claude-code', session_id: 'conv-1', subtype: 'tool_call', ...data })
const summary = (anchor: RedLogEvent, preview: string[] = []): ActivitySummary => ({ anchor, sourcePreview: { ids: preview, hasMore: false } } as unknown as ActivitySummary)

describe('aroundRelation', () => {
  it('names a command only through its ID inside one terminal', () => {
    const anchor = shell('a', 100, { command_id: 'c1' })
    expect(aroundRelation(anchor, shell('b', 101, { command_id: 'c1' }))).toBe('command')
    expect(aroundRelation(anchor, shell('b', 101, { command_id: 'c2' }))).toBe('session')
    // The same ID in another terminal is another command.
    expect(aroundRelation(anchor, shell('b', 101, { command_id: 'c1', terminalId: 'term-2' }))).toBeNull()
  })

  it('names a flow by its flow ID alone, and only when both carry one', () => {
    const anchor = ev('a', 100, 'scanner', { subtype: 'http_request_start', flow_id: 'f1' })
    expect(aroundRelation(anchor, ev('b', 101, 'scanner', { subtype: 'http_response', flow_id: 'f1' }))).toBe('flow')
    expect(aroundRelation(anchor, ev('b', 101, 'scanner', { subtype: 'http_response', flow_id: 'f2' }))).toBeNull()
    expect(aroundRelation(anchor, ev('b', 101, 'scanner', { subtype: 'http_response' }))).toBeNull()
    expect(aroundRelation(ev('a', 100, 'scanner', { flow_id: '' }), ev('b', 101, 'scanner', { flow_id: '' }))).toBeNull()
  })

  it('names a tool call only inside its conversation', () => {
    const anchor = tool('a', 100, { tool_use_id: 'u1' })
    expect(aroundRelation(anchor, tool('b', 101, { subtype: 'tool_result', tool_use_id: 'u1' }))).toBe('tool')
    expect(aroundRelation(anchor, tool('b', 101, { tool_use_id: 'u2' }))).toBe('session')
    expect(aroundRelation(anchor, tool('b', 101, { tool_use_id: 'u1', session_id: 'conv-2' }))).toBeNull()
  })

  it('says nothing for events that only share the clock', () => {
    const anchor = shell('a', 100, { command_id: 'c1' })
    expect(aroundRelation(anchor, tool('b', 100, { tool_use_id: 'u1' }))).toBeNull()
    expect(aroundRelation(anchor, ev('c', 100, 'marker', { title: 'note' }))).toBeNull()
    expect(aroundRelation(anchor, ev('d', 100, 'scanner', { flow_id: 'f1' }))).toBeNull()
  })

  it('does not relate across projects or capture Sessions by a matching ID', () => {
    const anchor = shell('a', 100, { command_id: 'c1' })
    expect(aroundRelation(anchor, { ...shell('b', 101, { command_id: 'c1' }), sessionId: 'capture-2' })).toBeNull()
    expect(aroundRelation(anchor, { ...shell('b', 101, { command_id: 'c1' }), engagementId: 'other' })).toBeNull()
  })

  it('prefers the strongest key', () => {
    const anchor = tool('a', 100, { tool_use_id: 'u1', flow_id: 'f1' })
    expect(aroundRelation(anchor, tool('b', 101, { tool_use_id: 'u1', flow_id: 'f1' }))).toBe('flow')
  })
})

describe('around window', () => {
  it('asks for the Timeline window, nearest rows first on each side', () => {
    const item = summary(shell('a', 1_000_000), ['x', 'y'])
    const { before, after } = aroundQueries(item, { inScopeOnly: true })
    const range = windowAround(1_000_000, AROUND_MINUTES)
    expect(before).toMatchObject({ since: range.since, before: 1_000_000, order: 'newest', excludeHousekeeping: true, inScopeOnly: true })
    expect(after).toMatchObject({ since: 1_000_000, before: range.before, order: 'oldest', excludeHousekeeping: true, inScopeOnly: true })
    // Room for the cap, the one extra that proves there is more, the anchor and its own sources.
    expect(before.limit).toBe(AROUND_PER_SIDE + 1 + 2 + 1)
  })

  it('lists at most five per side in clock order, without the operation\'s own events', () => {
    const item = summary(shell('anchor', 1_000), ['own'])
    const earlier = Array.from({ length: 8 }, (_, i) => ev(`b${i}`, 990 - i, 'marker', {}))
    const later = Array.from({ length: 8 }, (_, i) => ev(`f${i}`, 1_010 + i, 'marker', {}))
    const shaped = shapeAround(item, [earlier[0], shell('own', 995), ...earlier.slice(1)], [shell('anchor', 1_000), shell('own', 1_001), ...later])
    expect(shaped.before.map(e => e.id)).toEqual(['b4', 'b3', 'b2', 'b1', 'b0'])
    expect(shaped.after.map(e => e.id)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(shaped.moreBefore && shaped.moreAfter).toBe(true)
  })

  it('reports an empty window, and a side that fits whole', () => {
    const item = summary(shell('anchor', 1_000))
    const none = shapeAround(item, [], [shell('anchor', 1_000)])
    expect(none).toEqual({ before: [], after: [], moreBefore: false, moreAfter: false })
    const five = shapeAround(item, Array.from({ length: 5 }, (_, i) => ev(`b${i}`, 990 - i, 'marker', {})), [])
    expect(five.before).toHaveLength(5)
    expect(five.moreBefore).toBe(false)
  })
})

describe('formatOffset', () => {
  it('signs the distance and keeps it short', () => {
    expect(formatOffset(4_200)).toBe('+4.2 s')
    expect(formatOffset(-12_000)).toBe('−12 s')
    expect(formatOffset(0)).toBe('+0.0 s')
    expect(formatOffset(-72_000)).toBe('−1 m 12 s')
    expect(formatOffset(300_000)).toBe('+5 m 00 s')
  })
})
