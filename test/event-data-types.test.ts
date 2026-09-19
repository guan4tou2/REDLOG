import { describe, it, expect } from 'vitest'
import type { RedLogEvent } from '../src/core/db/event-types'
import {
  isShellEvent,
  isMarkerEvent,
  isSystemEvent,
  isScannerEvent,
  isDnsEvent,
  isScreenshotEvent,
  isCredentialEvent,
  hasSubtype,
} from '../src/core/db/event-data-types'

function fakeEvent(agentType: string, data: Record<string, unknown> = {}): RedLogEvent {
  return {
    id: 'evt-1',
    timestamp: Date.now(),
    engagementId: 'eng-1',
    sessionId: 'ses-1',
    operatorId: 'op-1',
    agentType,
    hostname: 'localhost',
    sourceIP: null,
    targetId: null,
    data,
    hash: 'abc',
    prevHash: null,
    createdAt: Date.now(),
  }
}

describe('event type guards', () => {
  const guards = [
    { fn: isShellEvent, agent: 'shell' },
    { fn: isMarkerEvent, agent: 'marker' },
    { fn: isSystemEvent, agent: 'system' },
    { fn: isScannerEvent, agent: 'scanner' },
    { fn: isDnsEvent, agent: 'dns' },
    { fn: isScreenshotEvent, agent: 'screenshot' },
    { fn: isCredentialEvent, agent: 'credential_use' },
  ] as const

  for (const { fn, agent } of guards) {
    it(`${fn.name} returns true for agentType="${agent}"`, () => {
      expect(fn(fakeEvent(agent))).toBe(true)
    })

    it(`${fn.name} returns false for unrelated agentType`, () => {
      const other = agent === 'shell' ? 'marker' : 'shell'
      expect(fn(fakeEvent(other))).toBe(false)
    })
  }

  it('isShellEvent narrows data to ShellEventData', () => {
    const e = fakeEvent('shell', { subtype: 'command', command: 'whoami', cwd: '/tmp' })
    if (isShellEvent(e)) {
      const d = e.data
      expect(d.subtype).toBe('command')
      expect(d.command).toBe('whoami')
    } else {
      expect.unreachable()
    }
  })

  it('isMarkerEvent narrows to MarkerEventData', () => {
    const e = fakeEvent('marker', { title: 'Found SQLi', severity: 'critical' })
    if (isMarkerEvent(e)) {
      expect(e.data.title).toBe('Found SQLi')
    } else {
      expect.unreachable()
    }
  })

  it('isSystemEvent narrows to SystemEventData with fallback', () => {
    const e = fakeEvent('system', { subtype: 'some_future_subtype', extra: 42 })
    if (isSystemEvent(e)) {
      expect(e.data.subtype).toBe('some_future_subtype')
    } else {
      expect.unreachable()
    }
  })

  it('isScannerEvent narrows http_response data', () => {
    const e = fakeEvent('scanner', { subtype: 'http_response', method: 'GET', url: 'http://target', status: 200 })
    if (isScannerEvent(e)) {
      expect(e.data.subtype).toBe('http_response')
    } else {
      expect.unreachable()
    }
  })
})

describe('hasSubtype', () => {
  it('returns true when subtype matches', () => {
    const data = { subtype: 'command', command: 'id' } as Record<string, unknown>
    expect(hasSubtype(data, 'command')).toBe(true)
  })

  it('returns false when subtype differs', () => {
    const data = { subtype: 'command_end' } as Record<string, unknown>
    expect(hasSubtype(data, 'command')).toBe(false)
  })

  it('returns false when subtype is absent', () => {
    expect(hasSubtype({}, 'command')).toBe(false)
  })

  it('narrows so subtype is accessible', () => {
    const data: Record<string, unknown> = { subtype: 'session_start', shell: '/bin/zsh' }
    if (hasSubtype(data, 'session_start')) {
      expect(data.subtype).toBe('session_start')
    } else {
      expect.unreachable()
    }
  })
})
