import { describe, expect, it } from 'vitest'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import type { RedLogEvent } from '../src/core/db/events'

const shell = (data: Record<string, unknown>): RedLogEvent => ({
  id: 'e1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op-1', agentType: 'shell',
  hostname: 'h', sourceIP: null, targetId: null, data, createdAt: 1
})

// A shell row's fields are whatever its producer sent: the local API and
// plugins can post a command row without `command` or `exit_code`. Once the
// housekeeping rule stopped hiding such a row (spec 038), it reaches the
// Timeline, and its title must neither throw nor print "undefined".
describe('a shell command row missing its fields', () => {
  for (const data of [
    { subtype: 'command_start' },
    { subtype: 'command_end' },
    { subtype: 'command_end', command: 'nmap -sV 10.0.0.5' }
  ]) {
    it(`still has a title: ${JSON.stringify(data)}`, () => {
      expect(eventTitle(shell(data))).not.toMatch(/undefined/)
    })
  }

  it('keeps what was recorded', () => {
    expect(eventTitle(shell({ subtype: 'command_end', command: 'id', exit_code: 1 }))).toBe('$ id → exit 1')
    expect(eventTitle(shell({ subtype: 'command_start', command: 'whoami' }))).toBe('$ whoami')
  })
})

// #290: a session recovered after a crash did not close; titling it
// "terminal closed" reads as a normal end. It says the recording was
// interrupted, and a command it left open says so too.
describe('a terminal recording the app never closed', () => {
  it('reads as interrupted, not closed', () => {
    expect(eventTitle(shell({ subtype: 'session_end', source: 'builtin-terminal', reason: 'recovered-orphan', recovered: true, exitCode: null })))
      .toBe('▪ terminal recording interrupted (app did not close it)')
  })

  it('names the command it left open as interrupted', () => {
    expect(eventTitle(shell({ subtype: 'command_boundary', source: 'builtin-terminal', reason: 'recovered-orphan', command_id: 'c1' })))
      .toBe('$ command interrupted: recording ended without its result')
  })

  it('still reads a normal close as closed', () => {
    expect(eventTitle(shell({ subtype: 'session_end', source: 'builtin-terminal', reason: 'shell-exited', exitCode: 0 }))).toBe('▪ terminal closed (exit 0)')
  })
})
