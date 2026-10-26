import { describe, it, expect } from 'vitest'
import {
  isCollapsibleAgentTurn, filterAgentTurns, collapseCommandPairs, formatGap
} from '../src/renderer/src/lib/timelineEvents'

// D1 decomposition: these were inline in Timeline.tsx (5000 lines, no direct
// coverage). Now unit-tested. Behaviour must match the previous inline code.

const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent =>
  ({ id: 'event', engagementId: 'project', sessionId: 'binding', agentType, data: { shell: 'zsh', terminalId: 'terminal', ...data } } as unknown as RedLogEvent)

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
  it('drops a command_start that has a matching command_end by source session and command ID', () => {
    const events = [
      ev('shell', { subtype: 'command_start', pid: 1, command: 'nmap x', command_id: 'cmd-1' }),
      ev('shell', { subtype: 'command_end', pid: 1, command: 'nmap x', command_id: 'cmd-1' }),
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

  it('does not hide a second identical command when only the first has ended', () => {
    const first = ev('shell', { subtype: 'command_start', pid: 1, command: 'ls', command_id: 'first' })
    const end = ev('shell', { subtype: 'command_end', pid: 1, command: 'ls', command_id: 'first' })
    const next = ev('shell', { subtype: 'command_start', pid: 1, command: 'ls', command_id: 'next' })
    expect(collapseCommandPairs([first, end, next])).toEqual([end, next])
  })

  it('keeps both halves when only PID and text match, or the source session is missing', () => {
    const start = ev('shell', { subtype: 'command_start', pid: 1, command: 'ls' })
    const end = ev('shell', { subtype: 'command_end', pid: 1, command: 'ls' })
    expect(collapseCommandPairs([start, end])).toEqual([start, end])
    start.data.command_id = end.data.command_id = 'cmd'
    start.data.terminalId = end.data.terminalId = ''
    expect(collapseCommandPairs([start, end])).toEqual([start, end])
  })

  it.each(['project', 'binding', 'terminal'])('does not pair the same ID across a different %s', boundary => {
    const start = ev('shell', { subtype: 'command_start', pid: 1, command: 'ls', command_id: 'cmd' })
    const end = ev('shell', { subtype: 'command_end', pid: 1, command: 'ls', command_id: 'cmd' })
    if (boundary === 'project') end.engagementId = 'other'
    if (boundary === 'binding') end.sessionId = 'other'
    if (boundary === 'terminal') end.data.terminalId = 'other'
    expect(collapseCommandPairs([start, end])).toEqual([start, end])
  })

  it('keeps conflicting results visible instead of folding away their start', () => {
    const start = ev('shell', { subtype: 'command_start', command_id: 'cmd', command: 'ls' })
    const good = ev('shell', { subtype: 'command_end', command_id: 'cmd', command: 'ls', exit_code: 0 })
    const bad = ev('shell', { subtype: 'command_end', command_id: 'cmd', command: 'ls', exit_code: 1 })
    expect(collapseCommandPairs([start, good, bad])).toEqual([start, good, bad])
  })

  it('leaves non-shell events untouched', () => {
    const events = [ev('scanner', { subtype: 'command_start' }), ev('dns', { subtype: 'command_start' })]
    expect(collapseCommandPairs(events)).toHaveLength(2)
  })
})

describe('formatGap', () => {
  it('formats minutes and hours compactly', () => {
    expect(formatGap(45 * 60_000)).toBe('45m')
    expect(formatGap(2 * 3600_000)).toBe('2h')
    expect(formatGap((60 + 15) * 60_000)).toBe('1h15m')
  })
})
