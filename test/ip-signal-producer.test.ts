import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import { IPSignalProducer, type IPProducerConfig } from '../src/main/services/producers/ip-signal-producer'
import type { AlertBus, IPChangeSignal } from '../src/core/alert'

// IPSignalProducer (src/main/services/producers/ip-signal-producer.ts): how an
// egress read becomes the address the verdict is computed on. DNS and HTTP are
// stubbed and time is fake; the producer is driven only through start(),
// configure() and the clock.

const h = vi.hoisted(() => ({
  resolve4: (_host: string): Promise<string[]> => Promise.reject(new Error('no DNS in this test')),
  resolveTxt: (_host: string): Promise<string[][]> => Promise.reject(new Error('no DNS in this test')),
  dnsQueries: 0
}))
vi.mock('dns/promises', () => ({
  Resolver: class {
    setServers(): void {}
    resolve4(host: string): Promise<string[]> { h.dnsQueries++; return h.resolve4(host) }
    resolveTxt(host: string): Promise<string[][]> { h.dnsQueries++; return h.resolveTxt(host) }
  }
}))

const A = 'https://a.test/ip'
const B = 'https://b.test/ip'

interface Answer { status?: number; body?: unknown; throws?: boolean; wait?: Promise<void> }
/** What each provider answers, in order; its last answer repeats. */
const script = new Map<string, Answer[]>()
const requests: string[] = []
const answer = (url: string, ...seq: Answer[]): void => { script.set(url, seq) }
const ip = (address: string): Answer => ({ body: { ip: address } })

const signals: IPChangeSignal[] = []
const bus = { dispatch: (s: IPChangeSignal) => { signals.push(s) } } as unknown as AlertBus
let producer: IPSignalProducer | null = null

/** A producer on HTTP provider A unless told otherwise, started, with its
 *  first check done. */
const begin = async (cfg: Partial<IPProducerConfig> = {}): Promise<IPSignalProducer> => {
  producer = new IPSignalProducer(bus)
  producer.configure({ ipMode: 'http', providers: [A], ...cfg })
  producer.start()
  await vi.advanceTimersByTimeAsync(0)
  return producer
}
/** Let one more poll interval pass (10 s unless configured otherwise). */
const next = (seconds = 10): Promise<void> => vi.advanceTimersByTimeAsync(seconds * 1000)
const state = (): ReturnType<IPSignalProducer['getState']> => producer!.getState()

beforeEach(() => {
  vi.useFakeTimers()
  script.clear()
  requests.length = 0
  signals.length = 0
  h.dnsQueries = 0
  h.resolve4 = () => Promise.reject(new Error('no DNS in this test'))
  h.resolveTxt = () => Promise.reject(new Error('no DNS in this test'))
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url)
    const queue = script.get(url) ?? [{ throws: true }]
    const a = queue.length > 1 ? queue.shift()! : queue[0]
    if (a.wait) await a.wait
    if (a.throws) throw new TypeError('fetch failed')
    const status = a.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => a.body }
  })
})

afterEach(() => {
  producer?.stop()
  producer = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HTTP answers — only an IPv4 address is an address (G-IP2)', () => {
  it('takes the address from `ip`', async () => {
    answer(A, ip('203.0.113.9'))
    await begin()
    expect(state()).toMatchObject({ external: '203.0.113.9', error: null, stale: false })
  })

  it('treats a JSON answer with no address in it as that provider failing', async () => {
    // It used to become the address "[object Object]", which misses every
    // list: with only a blacklist set that reads presumed_safe, shown as SAFE.
    answer(A, { body: { address: '198.51.100.7' } })
    answer(B, ip('203.0.113.9'))
    await begin({ providers: [A, B] })
    expect(state().external).toBe('203.0.113.9')
  })

  it('does not take a comma-separated origin for an address', async () => {
    // httpbin's `origin` lists the forwarding chain; no entry in it is
    // reliably the egress.
    answer(A, { body: { origin: '198.51.100.7, 203.0.113.1' } })
    answer(B, ip('203.0.113.9'))
    await begin({ providers: [A, B] })
    expect(state().external).toBe('203.0.113.9')
  })

  it('does not take an IPv6 answer: the lists cannot judge one (G-IP1)', async () => {
    answer(A, ip('2001:db8::7'))
    answer(B, ip('203.0.113.9'))
    await begin({ providers: [A, B] })
    expect(state().external).toBe('203.0.113.9')
  })

  it('accepts a bare JSON string', async () => {
    answer(A, { body: '203.0.113.9' })
    await begin()
    expect(state().external).toBe('203.0.113.9')
  })

  it('reads as a failure when every provider answers something else', async () => {
    answer(A, { body: { address: '198.51.100.7' } })
    answer(B, ip('not-an-address'))
    await begin({ providers: [A, B] })
    expect(state()).toMatchObject({ external: null, error: 'All IP providers failed', stale: true })
  })
})

describe('a throw while reading the internal address', () => {
  it('neither loses the external read nor stops the producer', async () => {
    answer(A, ip('203.0.113.9'))
    vi.spyOn(os, 'networkInterfaces').mockImplementationOnce(() => {
      throw new Error('uv_interface_addresses returned Unknown system error 1')
    })
    await begin()
    expect(state()).toMatchObject({ external: '203.0.113.9', internal: null })
    await next()
    expect(requests, 'the next poll still runs').toHaveLength(2)
  })

  it('clears the in-flight flag even when a read throws', async () => {
    // Nothing in a read is expected to throw any more, but a flag left set by
    // one that did would make every later check a no-op, stale marking
    // included. The bus stands in for anything downstream; check() is called
    // directly so the rejection is awaited here rather than left unhandled.
    answer(A, ip('203.0.113.9'))
    let fail = true
    const failingBus = { dispatch: () => { if (fail) { fail = false; throw new Error('downstream') } } } as unknown as AlertBus
    producer = new IPSignalProducer(failingBus)
    producer.configure({ ipMode: 'http', providers: [A] })
    const check = (): Promise<void> => (producer as unknown as { check: () => Promise<void> }).check()
    await expect(check()).rejects.toThrow('downstream')
    await check()
    expect(requests).toHaveLength(2)
  })
})

describe('§1.3 network.confirmations', () => {
  it('takes the first reading as-is: there is nothing to flap against', async () => {
    answer(A, ip('203.0.113.9'))
    await begin()
    expect(state()).toMatchObject({ external: '203.0.113.9', settling: false })
  })

  it('holds a new address for two reads and promotes it on the third (the default, 3)', async () => {
    answer(A, ip('203.0.113.9'), ip('198.51.100.7'))
    await begin()
    await next()
    expect(state()).toMatchObject({ external: '203.0.113.9', settling: true })
    await next()
    expect(state()).toMatchObject({ external: '203.0.113.9', settling: true })
    await next()
    expect(state()).toMatchObject({ external: '198.51.100.7', settling: false })
  })

  it('promotes on sight with 1', async () => {
    answer(A, ip('203.0.113.9'), ip('198.51.100.7'))
    await begin({ confirmations: 1 })
    await next()
    expect(state()).toMatchObject({ external: '198.51.100.7', settling: false })
  })

  it('ignores 0 and negative values and keeps the previous count, not "promote on sight"', async () => {
    answer(A, ip('203.0.113.9'), ip('198.51.100.7'))
    producer = new IPSignalProducer(bus)
    producer.configure({ ipMode: 'http', providers: [A], confirmations: 0 })
    producer.configure({ confirmations: -2 })
    producer.start()
    await vi.advanceTimersByTimeAsync(0)
    await next()
    await next()
    expect(state().external, 'still held after two reads').toBe('203.0.113.9')
    await next()
    expect(state().external).toBe('198.51.100.7')
  })

  it('never promotes a candidate that changes every read, and keeps settling', async () => {
    answer(A, ip('203.0.113.9'), ip('198.51.100.1'), ip('198.51.100.2'), ip('198.51.100.3'), ip('198.51.100.4'))
    await begin()
    for (let i = 0; i < 4; i++) await next()
    expect(state()).toMatchObject({ external: '203.0.113.9', settling: true })
  })

  it('drops a half-confirmed candidate when the old address returns', async () => {
    answer(A, ip('203.0.113.9'), ip('198.51.100.7'), ip('203.0.113.9'), ip('198.51.100.7'), ip('198.51.100.7'))
    await begin()
    await next()                       // candidate, one read
    await next()                       // the old address again: candidate dropped
    expect(state()).toMatchObject({ external: '203.0.113.9', settling: false })
    await next()
    await next()                       // two reads of a fresh hold, not three
    expect(state().external).toBe('203.0.113.9')
  })
})

describe('§1.4 network.ipMode and network.providers', () => {
  it('dns: asks the resolvers and never makes an HTTP request', async () => {
    h.resolve4 = async () => ['203.0.113.9']
    await begin({ ipMode: 'dns' })
    expect(state().external).toBe('203.0.113.9')
    expect(requests).toHaveLength(0)
  })

  it('http: makes the HTTP request and never asks DNS', async () => {
    answer(A, ip('203.0.113.9'))
    await begin({ ipMode: 'http' })
    expect(state().external).toBe('203.0.113.9')
    expect(h.dnsQueries).toBe(0)
  })

  it('auto: asks DNS first, and falls back to HTTP when DNS fails', async () => {
    answer(A, ip('203.0.113.9'))
    await begin({ ipMode: 'auto' })
    expect(h.dnsQueries).toBeGreaterThan(0)
    expect(state().external).toBe('203.0.113.9')

    h.resolve4 = async () => ['198.51.100.7']
    requests.length = 0
    await next()
    expect(requests, 'DNS answered, so no HTTP').toHaveLength(0)
  })

  it('falls through to the next provider when one throws or answers non-2xx', async () => {
    answer(A, { throws: true }, { status: 503, body: { ip: '198.51.100.7' } })
    answer(B, ip('203.0.113.9'))
    await begin({ providers: [A, B] })
    expect(state().external).toBe('203.0.113.9')
    requests.length = 0
    await next()
    expect(requests).toEqual([A, B])
    expect(state().external).toBe('203.0.113.9')
  })

  it('uses the built-in providers when configured with none', async () => {
    producer = new IPSignalProducer(bus)
    producer.configure({ ipMode: 'http', providers: [] })
    producer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(requests[0]).toBe('https://api.ipify.org?format=json')
  })

  it('keeps the last address with the error when every provider fails, and clears the error on the next success', async () => {
    answer(A, ip('203.0.113.9'), { throws: true }, ip('203.0.113.9'))
    await begin()
    await next()
    expect(state()).toMatchObject({ external: '203.0.113.9', error: 'All IP providers failed', stale: true })
    await next()
    expect(state()).toMatchObject({ external: '203.0.113.9', error: null, stale: false })
  })

  it('offline: makes no request at all and marks the read stale', async () => {
    await begin({ ipMode: 'auto', offline: true })
    expect(requests).toHaveLength(0)
    expect(h.dnsQueries).toBe(0)
    expect(state()).toMatchObject({ external: null, stale: true, error: 'offline (air-gap)' })
  })
})

describe('§1.5 network.checkInterval', () => {
  it('polls every 10 s unless configured', async () => {
    answer(A, ip('203.0.113.9'))
    await begin()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
  })

  it('polls at the configured interval', async () => {
    answer(A, ip('203.0.113.9'))
    await begin({ checkIntervalSec: 60 })
    await next(59)
    expect(requests).toHaveLength(1)
    await next(1)
    expect(requests).toHaveLength(2)
  })

  it('ignores 0 and negative intervals and keeps the previous one', async () => {
    answer(A, ip('203.0.113.9'))
    producer = new IPSignalProducer(bus)
    producer.configure({ ipMode: 'http', providers: [A], checkIntervalSec: 30 })
    producer.configure({ checkIntervalSec: 0 })
    producer.configure({ checkIntervalSec: -1 })
    producer.start()
    await vi.advanceTimersByTimeAsync(0)
    await next(29)
    expect(requests).toHaveLength(1)
    await next(1)
    expect(requests).toHaveLength(2)
  })

  it('skips a tick while a slow read is still in flight rather than queueing it', async () => {
    let release = (): void => {}
    const slow = new Promise<void>((r) => { release = r })
    answer(A, ip('203.0.113.9'), { wait: slow, body: { ip: '203.0.113.9' } }, ip('203.0.113.9'))
    await begin()
    await next()                     // the slow read starts
    await next()                     // this tick finds it still running
    expect(requests).toHaveLength(2)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await next()
    expect(requests).toHaveLength(3)
  })

  it('stops polling on stop(), and a second stop() is harmless', async () => {
    answer(A, ip('203.0.113.9'))
    const p = await begin()
    p.stop()
    p.stop()
    await next(60)
    expect(requests).toHaveLength(1)
  })
})
