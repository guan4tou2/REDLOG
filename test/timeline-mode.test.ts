import { describe, expect, it } from 'vitest'
import { parseTimelineMode } from '../src/renderer/src/lib/timelineMode'

describe('parseTimelineMode', () => {
  it('defaults to standard when nothing, or anything unknown, is stored', () => {
    expect(parseTimelineMode(null)).toBe('standard')
    expect(parseTimelineMode('')).toBe('standard')
    expect(parseTimelineMode('swimlanes')).toBe('standard')
  })
  it('keeps an explicit swim-lane choice', () => {
    expect(parseTimelineMode('lanes')).toBe('lanes')
    expect(parseTimelineMode('standard')).toBe('standard')
  })
})

import { singleTrackEvents } from '../src/renderer/src/lib/timelineFilters'
describe('singleTrackEvents', () => {
  const ev = (id: string, ts: number) => ({ id, ts } as never)
  it('keeps every event, including ones from different lanes, in time order', () => {
    const out = singleTrackEvents([ev('c', 30), ev('a', 10), ev('b', 20)], (e: { ts: number }) => e.ts)
    expect(out.map((e: { id: string }) => e.id)).toEqual(['a', 'b', 'c'])
  })
})
