import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedLogConfig } from '../../src/core/config'
import { AlertRuntime } from '../../src/main/services/alert-runtime'

// What `ip:getStatus` (AlertRuntime.ipStatus) says is safe. Safe needs an
// address that was read and is still being read; no address, a failed read, an
// air-gapped lookup, no lists, an address no longer read and a verdict judged
// against another project's lists are all unknown. HTTP is stubbed, DNS is
// refused, time is fake.

vi.mock('dns/promises', () => ({
  Resolver: class {
    setServers(): void {}
    resolve4(): Promise<string[]> { return Promise.reject(new Error('no DNS in this test')) }
    resolveTxt(): Promise<string[][]> { return Promise.reject(new Error('no DNS in this test')) }
  }
}))

const SAFE = '198.51.100.7'
let answers: Array<string | Error> = []
let runtime: AlertRuntime | null = null

const config = (network: Record<string, unknown>): RedLogConfig =>
  ({ network: { ipMode: 'http', providers: ['https://a.test/ip'], checkInterval: 10, ...network } }) as unknown as RedLogConfig
const identity = { projectId: 'p', engagementId: 'eng', operatorId: '' }

/** A runtime configured with `network`, started, its first read done. */
const begin = async (network: Record<string, unknown> = { whitelist: [SAFE] }): Promise<AlertRuntime> => {
  runtime = new AlertRuntime({ engagementId: 'eng', operatorId: '' })
  runtime.configure(config(network), identity, [])
  runtime.start()
  await vi.advanceTimersByTimeAsync(0)
  return runtime
}
const next = (seconds = 10): Promise<void> => vi.advanceTimersByTimeAsync(seconds * 1000)
const shown = (): string => runtime!.ipStatus().ipSafety

beforeEach(() => {
  vi.useFakeTimers()
  answers = [SAFE]
  vi.stubGlobal('fetch', async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (a instanceof Error) throw a
    return { ok: true, status: 200, json: async () => ({ ip: a }) }
  })
})

afterEach(() => {
  runtime?.stop()
  runtime = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ipStatus: safe needs a current address', () => {
  it('reads safe for an address on the safe list', async () => {
    await begin()
    expect(runtime!.ipStatus()).toMatchObject({ externalIP: SAFE, ipSafety: 'safe' })
  })

  it('is unknown before any address is read', () => {
    runtime = new AlertRuntime({ engagementId: 'eng', operatorId: '' })
    runtime.configure(config({ whitelist: [SAFE] }), identity, [])
    expect(runtime.ipStatus()).toMatchObject({ externalIP: null, ipSafety: 'unknown' })
  })

  it('is unknown when the lookup fails after a safe read', async () => {
    answers = [SAFE, new TypeError('fetch failed')]
    await begin()
    await next()
    expect(runtime!.ipStatus().error).toBeTruthy()
    expect(shown()).toBe('unknown')
  })

  it('is unknown in air-gap mode, which never reads an address', async () => {
    await begin({ whitelist: [SAFE], offline: true })
    expect(shown()).toBe('unknown')
  })

  it('is unknown with no safe and no exposed list', async () => {
    await begin({})
    expect(shown()).toBe('unknown')
  })

  it('stops reading safe once the safe address is no longer the one being read', async () => {
    // A pool that answers a different address every time never confirms a new
    // one, so the old address stays the stable value with its verdict.
    let n = 0
    answers = [SAFE]
    await begin()
    answers = []
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ip: `203.0.113.${++n}` }) }))
    await next(120)
    expect(runtime!.ipStatus().externalIP).toBe(SAFE)
    expect(shown()).toBe('unknown')
  })

  it('does not carry a safe verdict into the next project before it is re-read', async () => {
    await begin()
    expect(shown()).toBe('safe')
    runtime!.resetOnProjectSwitch()
    expect(shown()).toBe('unknown')
  })
})
