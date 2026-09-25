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
