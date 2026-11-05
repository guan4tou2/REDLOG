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
