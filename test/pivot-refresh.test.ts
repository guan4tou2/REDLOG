import { describe, it, expect } from 'vitest'
import { pivotsMayChange } from '../src/main/pivot-refresh'

const commandEnd = { agentType: 'shell', data: { subtype: 'command_end', command: 'ls' } }

describe('pivotsMayChange', () => {
  it('skips a command_end when no pivot is open in this project', () => {
    expect(pivotsMayChange(commandEnd, { projectId: 'p1', count: 0 }, 'p1')).toBe(false)
  })

  it('recomputes on a command_end while a pivot is open, since it may be the tunnel ending', () => {
    expect(pivotsMayChange(commandEnd, { projectId: 'p1', count: 1 }, 'p1')).toBe(true)
  })

  it('recomputes when there is no answer yet, or the answer belongs to another project', () => {
    expect(pivotsMayChange(commandEnd, null, 'p1')).toBe(true)
    expect(pivotsMayChange(commandEnd, { projectId: 'p0', count: 0 }, 'p1')).toBe(true)
  })

  it('always recomputes on a pivot event, and never on other events', () => {
    expect(pivotsMayChange({ agentType: 'pivot', data: {} }, { projectId: 'p1', count: 0 }, 'p1')).toBe(true)
    expect(pivotsMayChange({ agentType: 'shell', data: { subtype: 'command_start' } }, null, 'p1')).toBe(false)
    expect(pivotsMayChange({ agentType: 'scanner', data: { subtype: 'command_end' } }, null, 'p1')).toBe(false)
  })
})
