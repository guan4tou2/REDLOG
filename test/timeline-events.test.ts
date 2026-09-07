import { describe, it, expect } from 'vitest'
import {
  isCollapsibleAgentTurn, filterAgentTurns, collapseCommandPairs, fuzzyScore, formatGap
} from '../src/renderer/src/lib/timelineEvents'

// D1 decomposition: these were inline in Timeline.tsx (5000 lines, no direct
// coverage). Now unit-tested. Behaviour must match the previous inline code.

const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent =>
  ({ agentType, data } as unknown as RedLogEvent)

describe('isCollapsibleAgentTurn / filterAgentTurns', () => {
  it('collapses per-turn agent subtypes but keeps session-level + housekeeping', () => {
    expect(isCollapsibleAgentTurn(ev('agent', { subtype: 'tool_call' }))).toBe(true)
    expect(isCollapsibleAgentTurn(ev('agent', { subtype: 'thinking' }))).toBe(true)
    expect(isCollapsibleAgentTurn(ev('agent', { subtype: 'session_end' }))).toBe(false)
    expect(isCollapsibleAgentTurn(ev('agent', { subtype: 'schema_drift' }))).toBe(false)
    expect(isCollapsibleAgentTurn(ev('shell', { subtype: 'tool_call' }))).toBe(false) // wrong agentType
  })

  it('filterAgentTurns is a no-op when collapse is off', () => {
    const events = [ev('agent', { subtype: 'tool_call' }), ev('shell', { subtype: 'command_start' })]
    expect(filterAgentTurns(events, false)).toBe(events)
    expect(filterAgentTurns(events, true)).toHaveLength(1)
  })
})

describe('collapseCommandPairs', () => {
  it('drops a command_start that has a matching command_end (same pid + command)', () => {
    const events = [
      ev('shell', { subtype: 'command_start', pid: 1, command: 'nmap x' }),
      ev('shell', { subtype: 'command_end', pid: 1, command: 'nmap x' }),
      ev('shell', { subtype: 'command_start', pid: 2, command: 'still running' }) // no matching end
    ]
    const out = collapseCommandPairs(events)
    // The completed start is gone; its end and the running start remain.
    expect(out).toHaveLength(2)
    expect(out.some((e) => e.data?.subtype === 'command_end')).toBe(true)
    expect(out.some((e) => e.data?.subtype === 'command_start' && e.data?.pid === 2)).toBe(true)
    expect(out.some((e) => e.data?.subtype === 'command_start' && e.data?.pid === 1)).toBe(false)
  })

  it('does not collapse across a different pid or command', () => {
    const events = [
      ev('shell', { subtype: 'command_start', pid: 1, command: 'ls' }),
      ev('shell', { subtype: 'command_end', pid: 2, command: 'ls' })       // different pid
    ]
    expect(collapseCommandPairs(events)).toHaveLength(2)
  })

  it('leaves non-shell events untouched', () => {
    const events = [ev('scanner', { subtype: 'command_start' }), ev('dns', { subtype: 'command_start' })]
    expect(collapseCommandPairs(events)).toHaveLength(2)
  })
})

describe('fuzzyScore', () => {
  it('scores an earlier match higher, and no match as -1', () => {
    expect(fuzzyScore('nmap', 'nm')).toBeGreaterThan(fuzzyScore('unmap', 'nm')) // earlier index wins
    expect(fuzzyScore('nmap', 'xyz')).toBe(-1)
    expect(fuzzyScore('', 'q')).toBe(-1)
    expect(fuzzyScore('anything', '')).toBe(0)
    expect(fuzzyScore('NMAP', 'nmap')).toBeGreaterThan(0) // case-insensitive
  })
})

describe('formatGap', () => {
  it('formats minutes and hours compactly', () => {
    expect(formatGap(45 * 60_000)).toBe('45m')
    expect(formatGap(2 * 3600_000)).toBe('2h')
    expect(formatGap((60 + 15) * 60_000)).toBe('1h15m')
  })
})
