import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the DNS resolver so we can drive the DNS path deterministically (no real
// network). `state` is hoisted so the vi.mock factory can read it.
const state = vi.hoisted(() => ({ fail: false, ip: '9.9.9.9' }))
vi.mock('dns/promises', () => ({
  Resolver: class {
    setServers(): void {}
    async resolve4(): Promise<string[]> { if (state.fail) throw new Error('blocked'); return [state.ip] }
    async resolveTxt(): Promise<string[][]> { if (state.fail) throw new Error('blocked'); return [[state.ip]] }
  }
}))

import { IPMonitor } from '../src/core/ip-monitor'

function tick(m: IPMonitor): Promise<void> {
  return (m as unknown as { check: () => Promise<void> }).check()
}

describe('IPMonitor DNS mode', () => {
  let m: IPMonitor
  beforeEach(() => { m = new IPMonitor(); state.fail = false; state.ip = '9.9.9.9' })
  afterEach(() => vi.unstubAllGlobals())

  it("mode 'dns' resolves via DNS, no HTTP", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    m.configure({ ipMode: 'dns' })
    await tick(m)
    expect(m.status.externalIP).toBe('9.9.9.9')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("mode 'auto' prefers DNS when it succeeds", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '1.1.1.1' }) } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    m.configure({ ipMode: 'auto' })
    await tick(m)
    expect(m.status.externalIP).toBe('9.9.9.9') // DNS, not the HTTP 1.1.1.1
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("mode 'auto' falls back to HTTP when DNS is blocked", async () => {
    state.fail = true
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '1.1.1.1' }) } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    m.configure({ ipMode: 'auto' })
    await tick(m)
    expect(m.status.externalIP).toBe('1.1.1.1') // fell back to HTTP
    expect(fetchMock).toHaveBeenCalled()
  })
})
