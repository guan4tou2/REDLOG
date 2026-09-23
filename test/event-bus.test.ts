import { describe, it, expect, beforeEach } from 'vitest'
import { eventBus } from '../src/core/event-bus'
import type { RedLogEvent } from '../src/core/db/events'

const ev = (agentType: string): RedLogEvent => ({
  id: 'e1', timestamp: Date.now(), engagementId: 'eng', sessionId: 's',
  operatorId: 'op', agentType, hostname: 'h', sourceIP: null, targetId: null,
  data: { subtype: 'test' }, createdAt: Date.now()
})

describe('eventBus', () => {
  beforeEach(() => {
    eventBus.removeAllListeners()
    if (eventBus.paused) eventBus.resume()
  })

  it('publishes events to listeners', async () => {
    const received: RedLogEvent[] = []
    eventBus.on('event', (e: RedLogEvent) => received.push(e))
    eventBus.publish(ev('shell'))
    await new Promise(r => queueMicrotask(r))
    expect(received).toHaveLength(1)
    expect(received[0].agentType).toBe('shell')
  })

  it('emits typed event:agentType channel', async () => {
    const shellEvents: RedLogEvent[] = []
    const dnsEvents: RedLogEvent[] = []
    eventBus.on('event:shell', (e: RedLogEvent) => shellEvents.push(e))
    eventBus.on('event:dns', (e: RedLogEvent) => dnsEvents.push(e))
    eventBus.publish(ev('shell'))
    eventBus.publish(ev('dns'))
    await new Promise(r => queueMicrotask(r))
    expect(shellEvents).toHaveLength(1)
    expect(dnsEvents).toHaveLength(1)
  })

  it('suppresses events when paused', async () => {
    const received: RedLogEvent[] = []
    eventBus.on('event', (e: RedLogEvent) => received.push(e))
    eventBus.pause('ui')
    expect(eventBus.paused).toBe(true)
    eventBus.publish(ev('shell'))
    await new Promise(r => queueMicrotask(r))
    expect(received).toHaveLength(0)
  })

  it('allows bypassPause events through', async () => {
    const received: RedLogEvent[] = []
    eventBus.on('event', (e: RedLogEvent) => received.push(e))
    eventBus.pause('api')
    eventBus.publish(ev('system'), { bypassPause: true })
    await new Promise(r => queueMicrotask(r))
    expect(received).toHaveLength(1)
  })

  it('resumes after pause', async () => {
    const received: RedLogEvent[] = []
    eventBus.on('event', (e: RedLogEvent) => received.push(e))
    eventBus.pause('ui')
    eventBus.resume('ui')
    expect(eventBus.paused).toBe(false)
    eventBus.publish(ev('shell'))
    await new Promise(r => queueMicrotask(r))
    expect(received).toHaveLength(1)
  })

  it('emits recording toggle with source', () => {
    const toggles: [boolean, string][] = []
    eventBus.on('recording', (active: boolean, source: string) => toggles.push([active, source]))
    eventBus.pause('mcp')
    eventBus.pause('mcp') // repeated requests must not manufacture audit boundaries
    eventBus.resume('api')
    eventBus.resume('api')
    expect(toggles).toEqual([[false, 'mcp'], [true, 'api']])
  })

  it('preserves order across multiple publishes in same tick', async () => {
    const order: string[] = []
    eventBus.on('event', (e: RedLogEvent) => order.push(e.agentType))
    eventBus.publish(ev('shell'))
    eventBus.publish(ev('dns'))
    eventBus.publish(ev('screenshot'))
    await new Promise(r => queueMicrotask(r))
    await new Promise(r => queueMicrotask(r))
    expect(order).toEqual(['shell', 'dns', 'screenshot'])
  })
})
