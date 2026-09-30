import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPSignalProducer, type IPProducerConfig } from '../src/main/services/producers/ip-signal-producer'
import type { AlertBus } from '../src/core/alert'
import { egressContext } from '../src/core/db/bookmarks'

// A bookmark's auto-captured context names the egress address. After a failed
// read, and in air-gap mode, the IP producer still holds the last stable
// address. `bookmarks:create` recorded that as `externalIP`, so the detail
// pane showed an address nobody had read when the bookmark was made as the one
// in use. The producer is driven as in ip-signal-producer.test.ts: HTTP
// provider stubbed, time fake.

const P = 'https://p.test/ip'
let answers: Array<{ ip?: string; fail?: boolean }> = []
const bus = { dispatch: () => {} } as unknown as AlertBus
let producer: IPSignalProducer | null = null

const begin = async (cfg: Partial<IPProducerConfig> = {}): Promise<IPSignalProducer> => {
  producer = new IPSignalProducer(bus)
  producer.configure({ ipMode: 'http', providers: [P], ...cfg })
  producer.start()
  await vi.advanceTimersByTimeAsync(0)
  return producer
}
/** One more poll interval (10 s by default). */
const next = (): Promise<void> => vi.advanceTimersByTimeAsync(10_000)
const context = (): ReturnType<typeof egressContext> => egressContext(producer!.getState())

beforeEach(() => {
  vi.useFakeTimers()
  answers = []
  vi.stubGlobal('fetch', async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0] ?? { fail: true }
    if (a.fail) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ ip: a.ip }) }
  })
})

afterEach(() => {
  producer?.stop()
  producer = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the egress address a bookmark records', () => {
  it('is the current address after a successful read', async () => {
    answers = [{ ip: '203.0.113.7' }]
    await begin()
    expect(context()).toEqual({ externalIP: '203.0.113.7' })
  })

  it('after a failed read, is only the last known address, with when it was read', async () => {
    answers = [{ ip: '203.0.113.7' }, { fail: true }]
    await begin()
    const readAt = Date.now()
    await next()
    expect(producer!.getState().stale).toBe(true)
    const ctx = context()
    expect(ctx.externalIP).toBeUndefined()
    expect(ctx.lastKnownExternalIP).toEqual({ address: '203.0.113.7', readAt })
  })

  it('in air-gap mode, is only the last known address too', async () => {
    answers = [{ ip: '203.0.113.7' }]
    await begin()
    const readAt = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    producer!.configure({ offline: true })  // re-arms, and reads at once
    await vi.advanceTimersByTimeAsync(0)
    expect(producer!.getState().error).toBe('offline (air-gap)')
    const ctx = context()
    expect(ctx.externalIP).toBeUndefined()
    expect(ctx.lastKnownExternalIP).toEqual({ address: '203.0.113.7', readAt })
  })

  it('dates the last known address by its own read, not a candidate read after it', async () => {
    // confirmations 3: the second address is read once and not promoted, so
    // the stable address was last read at `readAt`, not at the candidate read.
    answers = [{ ip: '203.0.113.7' }, { ip: '198.51.100.4' }, { fail: true }]
    await begin({ confirmations: 3 })
    const readAt = Date.now()
    await next()
    expect(producer!.getState().settling).toBe(true)
    expect(context()).toEqual({ externalIP: '203.0.113.7' })
    await next()
    expect(context().lastKnownExternalIP).toEqual({ address: '203.0.113.7', readAt })
  })

  it('is absent before any read has succeeded', async () => {
    answers = [{ fail: true }]
    await begin()
    expect(producer!.getState().external).toBeNull()
    expect(context()).toEqual({})
  })
})
