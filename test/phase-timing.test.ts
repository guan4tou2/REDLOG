import { describe, it, expect } from 'vitest'
import { timePhase } from './helpers/phase-timing'

describe('timePhase', () => {
  it('returns the value and prints nothing for a fast phase', () => {
    const lines: string[] = []
    expect(timePhase('fast', () => 7, (l) => lines.push(l))).toBe(7)
    expect(lines).toEqual([])
  })

  it('prints one JSON line with wall and cpu time for a slow phase, and rethrows', () => {
    const lines: string[] = []
    expect(() => timePhase('slow', () => { throw new Error('boom') }, (l) => lines.push(l), -1)).toThrow('boom')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.slowPhase).toBe('slow')
    expect(typeof parsed.wallMs).toBe('number')
    expect(typeof parsed.cpuMs).toBe('number')
    expect(parsed.platform).toBe(process.platform)
  })
})
