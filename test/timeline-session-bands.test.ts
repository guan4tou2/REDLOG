import { describe, it, expect } from 'vitest'
import { buildSessionBands, type SessionBandLabels } from '../src/renderer/src/lib/timelineSessionBands'

const labels: SessionBandLabels = {
  termLabel: (id) => `T:${id}`,
  pausedLabel: 'Paused'
}
const linear = (ts: number): number => ts

describe('buildSessionBands', () => {
  it('returns empty for no events', () => {
    expect(buildSessionBands([], linear, labels, 100000)).toEqual([])
  })

  it('creates a term band from shell.session_end with durationMs', () => {
    const events = [{
      id: 'e1', timestamp: 50000, agentType: 'shell',
      data: { subtype: 'session_end', terminalId: 'abcd1234', durationMs: 30000 }
    }]
    const bands = buildSessionBands(events, linear, labels, 60000)
    expect(bands).toHaveLength(1)
    expect(bands[0].kind).toBe('term')
    expect(bands[0].x0).toBe(20000)
    expect(bands[0].x1).toBe(50000)
    expect(bands[0].label).toBe('T:abcd')
  })

  it('creates a paused band from pause/resume pair', () => {
    const events = [
      { id: 'p1', timestamp: 10000, agentType: 'system', data: { subtype: 'recording_paused' } },
      { id: 'r1', timestamp: 20000, agentType: 'system', data: { subtype: 'recording_resumed' } }
    ]
    const bands = buildSessionBands(events, linear, labels, 30000)
    expect(bands).toHaveLength(1)
    expect(bands[0].kind).toBe('paused')
    expect(bands[0].x0).toBe(10000)
    expect(bands[0].x1).toBe(20000)
  })

  it('trailing pause without resume extends to timeEnd', () => {
    const events = [
      { id: 'p1', timestamp: 10000, agentType: 'system', data: { subtype: 'recording_paused' } }
    ]
    const bands = buildSessionBands(events, linear, labels, 50000)
    expect(bands).toHaveLength(1)
    expect(bands[0].x1).toBeLessThanOrEqual(50000)
  })

  it('double pause closes previous band at next pause timestamp', () => {
    const events = [
      { id: 'p1', timestamp: 10000, agentType: 'system', data: { subtype: 'recording_paused' } },
      { id: 'p2', timestamp: 20000, agentType: 'system', data: { subtype: 'recording_paused' } }
    ]
    const bands = buildSessionBands(events, linear, labels, 30000)
    expect(bands).toHaveLength(2)
    expect(bands[0].x1).toBe(20000)
  })

  it('staggers overlapping bands into separate rows', () => {
    const events = [
      { id: 'e1', timestamp: 5000, agentType: 'shell', data: { subtype: 'session_end', terminalId: 'aa', durationMs: 5000 } },
      { id: 'e2', timestamp: 5000, agentType: 'shell', data: { subtype: 'session_end', terminalId: 'bb', durationMs: 5000 } }
    ]
    const bands = buildSessionBands(events, linear, labels, 10000)
    expect(bands).toHaveLength(2)
    const rows = new Set(bands.map((b) => b.row))
    expect(rows.size).toBe(2)
  })

  it('non-overlapping bands share row 0', () => {
    const events = [
      { id: 'e1', timestamp: 100, agentType: 'shell', data: { subtype: 'session_end', terminalId: 'aa', durationMs: 50 } },
      { id: 'e2', timestamp: 300, agentType: 'shell', data: { subtype: 'session_end', terminalId: 'bb', durationMs: 50 } }
    ]
    const bands = buildSessionBands(events, linear, labels, 400)
    expect(bands.every((b) => b.row === 0)).toBe(true)
  })
})
