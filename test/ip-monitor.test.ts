import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPMonitor } from '../src/core/ip-monitor'

// Drive check() directly rather than the timer — we're testing the settling
// rule, not the schedule.
function tick(m: IPMonitor): Promise<void> {
  return (m as unknown as { check: () => Promise<void> }).check()
}

function mockIPs(...sequence: string[]): void {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    const ip = sequence[Math.min(i, sequence.length - 1)]
    i += 1
    return { ok: true, json: async () => ({ ip }) } as unknown as Response
  }))
}

describe('IPMonitor settling', () => {
  let m: IPMonitor

  beforeEach(() => {
    m = new IPMonitor()
    m.configure({
      whitelist: ['10.8.0.0/24'],
      blacklist: ['203.0.113.0/24'],
      confirmations: 3
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('accepts the first reading immediately — nothing to flap against yet', async () => {
    mockIPs('10.8.0.5')
    await tick(m)
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.ipSafety).toBe('safe')
    expect(m.status.settling).toBe(false)
  })

  it('holds the displayed address until a new one repeats enough times', async () => {
    mockIPs('10.8.0.5', '203.0.113.9', '203.0.113.9', '203.0.113.9')
    await tick(m)

    await tick(m) // 1st sighting of the new address
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.ipSafety).toBe('safe')
    expect(m.status.settling).toBe(true)

    await tick(m) // 2nd
    expect(m.status.externalIP).toBe('10.8.0.5')

    await tick(m) // 3rd — confirmed, promote
    expect(m.status.externalIP).toBe('203.0.113.9')
    expect(m.status.ipSafety).toBe('exposed')
    expect(m.status.settling).toBe(false)
  })

  it('does not promote an address that keeps changing — the CGNAT case', async () => {
    mockIPs('10.8.0.5', '203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4')
    await tick(m)
    for (let i = 0; i < 4; i++) await tick(m)
    // Every candidate differed from the last, so none ever reached 3 in a row.
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.ipSafety).toBe('safe')
    expect(m.status.settling).toBe(true)
  })

  it('clears a half-confirmed candidate when the old address comes back', async () => {
    mockIPs('10.8.0.5', '203.0.113.9', '10.8.0.5', '203.0.113.9', '203.0.113.9')
    await tick(m)
    await tick(m) // candidate seen once
    await tick(m) // back to the settled address — candidate must reset
    expect(m.status.settling).toBe(false)

    await tick(m) // candidate seen once again
    await tick(m) // twice — still short of 3, so no promotion
    expect(m.status.externalIP).toBe('10.8.0.5')
  })

  it('surfaces provider failure without discarding the last known address', async () => {
    mockIPs('10.8.0.5')
    await tick(m)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await tick(m)
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.error).toBeTruthy()
  })

  it('blacklist (own IP) wins over whitelist — identity leak must not be masked', async () => {
    m.configure({ whitelist: ['203.0.113.0/24'], blacklist: ['203.0.113.0/24'] })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')
  })

  it('blacklist mode: IP not in blacklist is implicitly safe', async () => {
    const b = new IPMonitor()
    b.configure({ blacklist: ['203.0.113.0/24'], confirmations: 1 })
    mockIPs('198.51.100.5')
    await tick(b)
    expect(b.status.externalIP).toBe('198.51.100.5')
    expect(b.status.ipSafety).toBe('safe')
  })

  it('honours a custom provider list so an operator can self-host', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '10.8.0.5' }) } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    m.configure({ providers: ['https://ip.internal.example/json'] })
    await tick(m)
    expect(fetchMock.mock.calls[0][0]).toBe('https://ip.internal.example/json')
  })
})
