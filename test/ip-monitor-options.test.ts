// Per-option coverage for the network block: every knob in `config.network`
// (checkInterval, confirmations, providers, ipMode, whitelist/blacklist ranges)
// against its default, its boundary values, and its junk values.
//
// `ip-monitor.test.ts` covers the settling narrative and the A-1..A-9 verdict
// matrix; `ip-monitor-dns.test.ts` covers dns/auto mode selection. This file is
// the "does each configured NUMBER actually take effect" half.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPMonitor, classifyIP } from '../src/core/ip-monitor'

function tick(m: IPMonitor): Promise<void> {
  return (m as unknown as { check: () => Promise<void> }).check()
}

/** Answer every provider with the same address. */
function mockIP(ip: string): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => ({ ok: true, json: async () => ({ ip }) } as unknown as Response))
  vi.stubGlobal('fetch', f)
  return f
}

/** Answer per-URL, so provider fallback order is observable. */
function mockByUrl(map: Record<string, { ok?: boolean; body?: unknown; throws?: boolean }>): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string) => {
    const hit = map[url]
    if (!hit || hit.throws) throw new Error(`unreachable: ${url}`)
    return { ok: hit.ok !== false, json: async () => hit.body } as unknown as Response
  })
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('network.checkInterval — seconds in, milliseconds on the timer', () => {
  it('defaults to a 10s poll when nothing is configured', () => {
    mockIP('10.8.0.5')
    const spy = vi.spyOn(globalThis, 'setInterval')
    const m = new IPMonitor()
    m.configure({ ipMode: 'http' })
    m.start()
    expect(spy.mock.calls[0][1]).toBe(10_000)
    m.stop()
  })

  it('converts the configured seconds to milliseconds', () => {
    mockIP('10.8.0.5')
    const spy = vi.spyOn(globalThis, 'setInterval')
    const m = new IPMonitor()
    m.configure({ checkInterval: 60, ipMode: 'http' })   // the shipped default
    m.start()
    expect(spy.mock.calls[0][1]).toBe(60_000)
    m.stop()
  })

  it('ignores 0 — a zero-second poll would be a busy loop', () => {
    mockIP('10.8.0.5')
    const spy = vi.spyOn(globalThis, 'setInterval')
    const m = new IPMonitor()
    m.configure({ checkInterval: 0, ipMode: 'http' })
    m.start()
    expect(spy.mock.calls[0][1]).toBe(10_000)
    m.stop()
  })

  it('stop() clears the timer so a closed project stops polling', () => {
    mockIP('10.8.0.5')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const m = new IPMonitor()
    m.configure({ ipMode: 'http' })
    m.start()
    m.stop()
    expect(clear).toHaveBeenCalled()
    m.stop()   // idempotent
  })
})

describe('network.confirmations — how many identical reads promote a new address', () => {
  async function promoteAfter(confirmations: number | undefined, reads: number): Promise<string | null> {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], confirmations, ipMode: 'http' })
    mockIP('10.8.0.5')
    await tick(m)                       // first reading is taken as-is
    mockIP('5.6.7.8')
    for (let i = 0; i < reads; i++) await tick(m)
    return m.status.externalIP
  }

  it('1 = promote on sight (no flap protection)', async () => {
    expect(await promoteAfter(1, 1)).toBe('5.6.7.8')
  })

  it('3 (the default) holds the old address for two reads, promotes on the third', async () => {
    expect(await promoteAfter(undefined, 2)).toBe('10.8.0.5')
    expect(await promoteAfter(undefined, 3)).toBe('5.6.7.8')
  })

  it('5 holds for four reads', async () => {
    expect(await promoteAfter(5, 4)).toBe('10.8.0.5')
    expect(await promoteAfter(5, 5)).toBe('5.6.7.8')
  })

  it('0 is rejected — falls back to the default of 3, not "promote instantly"', async () => {
    expect(await promoteAfter(0, 2)).toBe('10.8.0.5')
    expect(await promoteAfter(0, 3)).toBe('5.6.7.8')
  })

  it('a negative value is rejected the same way', async () => {
    expect(await promoteAfter(-1, 2)).toBe('10.8.0.5')
  })

  it('settling stays true for the whole hold, then clears on promotion', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], confirmations: 3, ipMode: 'http' })
    mockIP('10.8.0.5')
    await tick(m)
    expect(m.status.settling).toBe(false)
    mockIP('5.6.7.8')
    await tick(m); expect(m.status.settling).toBe(true)
    await tick(m); expect(m.status.settling).toBe(true)
    await tick(m); expect(m.status.settling).toBe(false)
  })

  it('the displayed verdict does not change while settling — no badge flicker', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], blacklist: ['5.6.7.8'], confirmations: 3, ipMode: 'http' })
    mockIP('10.8.0.5')
    await tick(m)
    mockIP('5.6.7.8')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')       // still the last stable read
    await tick(m)
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')    // and only now the alarm
  })
})

describe('network.providers — HTTP echo list', () => {
  it('falls through to the next provider when the first one throws', async () => {
    const f = mockByUrl({
      'https://a.test/ip': { throws: true },
      'https://b.test/ip': { body: { ip: '5.6.7.8' } }
    })
    const m = new IPMonitor()
    m.configure({ providers: ['https://a.test/ip', 'https://b.test/ip'], ipMode: 'http' })
    await tick(m)
    expect(m.status.externalIP).toBe('5.6.7.8')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('treats a non-200 as a failure and moves on', async () => {
    mockByUrl({
      'https://a.test/ip': { ok: false, body: { ip: '1.1.1.1' } },
      'https://b.test/ip': { body: { ip: '5.6.7.8' } }
    })
    const m = new IPMonitor()
    m.configure({ providers: ['https://a.test/ip', 'https://b.test/ip'], ipMode: 'http' })
    await tick(m)
    expect(m.status.externalIP).toBe('5.6.7.8')
  })

  it('accepts the {origin} shape as well as {ip}', async () => {
    mockByUrl({ 'https://a.test/ip': { body: { origin: '5.6.7.8' } } })
    const m = new IPMonitor()
    m.configure({ providers: ['https://a.test/ip'], ipMode: 'http' })
    await tick(m)
    expect(m.status.externalIP).toBe('5.6.7.8')
  })

  it('an empty provider list is ignored — the built-in list is used', async () => {
    const f = mockIP('5.6.7.8')
    const m = new IPMonitor()
    m.configure({ providers: [], ipMode: 'http' })
    await tick(m)
    expect(String(f.mock.calls[0][0])).toContain('ipify.org')
  })

  it('every provider failing sets an error and keeps the last known address', async () => {
    const m = new IPMonitor()
    m.configure({ providers: ['https://a.test/ip', 'https://b.test/ip'], ipMode: 'http' })
    mockByUrl({ 'https://a.test/ip': { body: { ip: '5.6.7.8' } } })
    await tick(m)
    mockByUrl({})   // both unreachable
    await tick(m)
    expect(m.status.externalIP).toBe('5.6.7.8')
    expect(m.status.error).toBe('All IP providers failed')
  })

  it('a later success clears the error', async () => {
    const m = new IPMonitor()
    m.configure({ providers: ['https://a.test/ip'], confirmations: 1, ipMode: 'http' })
    mockByUrl({})
    await tick(m)
    expect(m.status.error).toBeTruthy()
    mockByUrl({ 'https://a.test/ip': { body: { ip: '5.6.7.8' } } })
    await tick(m)
    expect(m.status.error).toBeNull()
  })
})

describe('network.ipMode = http', () => {
  it('never touches DNS — every read is an HTTP GET', async () => {
    const f = mockIP('5.6.7.8')
    const m = new IPMonitor()
    m.configure({ ipMode: 'http' })
    await tick(m)
    expect(f).toHaveBeenCalled()
    expect(m.status.externalIP).toBe('5.6.7.8')
  })
})

describe('overlapping checks', () => {
  it('a slow poll is not re-entered by the next tick', async () => {
    let resolve!: (v: unknown) => void
    const gate = new Promise((r) => { resolve = r })
    const f = vi.fn(async () => {
      await gate
      return { ok: true, json: async () => ({ ip: '5.6.7.8' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', f)
    const m = new IPMonitor()
    m.configure({ ipMode: 'http' })
    const first = tick(m)
    await tick(m)                       // returns immediately, guarded
    expect(f).toHaveBeenCalledTimes(1)
    resolve(null)
    await first
  })
})

// The range arithmetic behind "did my egress land inside the list I declared".
// classifyIP is pure, so every boundary is a one-liner.
describe('whitelist / blacklist range matching', () => {
  const wl = (cidr: string, ip: string): string => classifyIP(ip, { whitelist: [cidr], blacklist: [] })

  const inRange: Array<[string, string]> = [
    ['10.8.0.0/24', '10.8.0.0'],      // network address
    ['10.8.0.0/24', '10.8.0.255'],    // broadcast address
    ['10.8.0.0/24', '10.8.0.1'],
    ['172.16.0.0/12', '172.31.255.255'],
    ['203.0.113.42/32', '203.0.113.42'],
    ['0.0.0.0/0', '198.51.100.7'],    // match-everything
    ['203.0.113.42', '203.0.113.42']  // bare IP, no mask
  ]
  for (const [cidr, ip] of inRange) {
    it(`${ip} is inside ${cidr}`, () => expect(wl(cidr, ip)).toBe('safe'))
  }

  const outOfRange: Array<[string, string]> = [
    ['10.8.0.0/24', '10.8.1.0'],       // one past the top
    ['10.8.0.0/24', '10.7.255.255'],   // one below the bottom
    ['172.16.0.0/12', '172.32.0.1'],
    ['203.0.113.42/32', '203.0.113.43'],
    ['203.0.113.42', '203.0.113.4'],   // bare IP is exact, not a prefix
    ['10.8.0.0/24', '2001:db8::1']     // family mismatch never matches
  ]
  for (const [cidr, ip] of outOfRange) {
    it(`${ip} is outside ${cidr}`, () => expect(wl(cidr, ip)).toBe('unknown'))
  }

  // Was "an IPv6 CIDR matches only the literal prefix address (documented
  // limitation)" — that limitation was the G-A5 defect and is now closed:
  // `ip-match.ts` does real v6 prefix matching. Full v6 coverage lives in
  // `ip-match.test.ts`; these two keep the option-level path honest.
  it('an IPv6 CIDR matches the whole prefix, not just its literal address', () => {
    expect(wl('2001:db8::1/64', '2001:db8::1')).toBe('safe')
    expect(wl('2001:db8::1/64', '2001:db8::2')).toBe('safe')
  })

  it('an IPv6 address outside the prefix is still not safe', () => {
    expect(wl('2001:db8:0:1::/64', '2001:db8:0:2::1')).toBe('unknown')
  })

  it('a hit on any one entry of a multi-entry list is enough', () => {
    expect(classifyIP('198.51.100.7', { whitelist: ['10.8.0.0/24', '198.51.100.0/24'], blacklist: [] })).toBe('safe')
  })

  it('blacklist ranges work the same way and still win over the whitelist', () => {
    expect(classifyIP('10.8.0.9', { whitelist: ['10.8.0.0/24'], blacklist: ['10.8.0.0/28'] })).toBe('exposed')
    expect(classifyIP('10.8.0.20', { whitelist: ['10.8.0.0/24'], blacklist: ['10.8.0.0/28'] })).toBe('safe')
  })
})
