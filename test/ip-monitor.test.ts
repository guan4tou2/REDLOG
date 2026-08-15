import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPMonitor, classifyIP, hasListConflict, verdictAuthority, type IPSafety } from '../src/core/ip-monitor'

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
      confirmations: 3,
      ipMode: 'http'
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
    m.configure({ whitelist: ['203.0.113.0/24'], blacklist: ['203.0.113.0/24'], ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')
  })

  // G-A2: this used to answer plain `safe`. "Not obviously you" is an
  // inference, not the verified statement "on the exit list you approved" —
  // it now says so instead of borrowing a fact's solid green.
  it('blacklist mode: IP not in blacklist is PRESUMED safe, not verified safe', async () => {
    const b = new IPMonitor()
    b.configure({ blacklist: ['203.0.113.0/24'], confirmations: 1, ipMode: 'http' })
    mockIPs('198.51.100.5')
    await tick(b)
    expect(b.status.externalIP).toBe('198.51.100.5')
    expect(b.status.ipSafety).toBe('presumed_safe')
  })

  it('honours a custom provider list so an operator can self-host', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '10.8.0.5' }) } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    m.configure({ providers: ['https://ip.internal.example/json'], ipMode: 'http' })
    await tick(m)
    expect(fetchMock.mock.calls[0][0]).toBe('https://ip.internal.example/json')
  })
})

// The verdict combination matrix (`docs/ALERT-ROLES.md` Part A.1). Four bits
// decide everything: whitelist configured, blacklist configured, and whether the
// address hits either. Nine reachable cells — table-driven so a new verdict
// (G-A2) is a column change, not a rewrite.
describe('classifyIP — the A-1..A-9 combination matrix', () => {
  const WL = ['10.8.0.0/24']   // "my VPN"
  const BL = ['1.2.3.4']       // "my home IP"
  const VPN = '10.8.0.5'
  const HOME = '1.2.3.4'
  const NEITHER = '5.6.7.8'    // VPN dropped, now on café NAT

  const cases: Array<[string, string, string[], string[], IPSafety]> = [
    ['A-1  no lists at all                    ', NEITHER, [], [], 'unknown'],
    ['A-2  blacklist only, hit                ', HOME, [], BL, 'exposed'],
    ['A-3  blacklist only, miss               ', NEITHER, [], BL, 'presumed_safe'],
    ['A-4  whitelist only, hit                ', VPN, WL, [], 'safe'],
    ['A-5  whitelist only, miss               ', NEITHER, WL, [], 'off_profile'],
    ['A-6  both, hits both (config conflict)  ', HOME, [...WL, HOME], BL, 'exposed'],
    ['A-7  both, hits blacklist               ', HOME, WL, BL, 'exposed'],
    ['A-8  both, hits whitelist               ', VPN, WL, BL, 'safe'],
    ['A-9  both, hits NEITHER                 ', NEITHER, WL, BL, 'off_profile']
  ]

  for (const [name, ip, whitelist, blacklist, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyIP(ip, { whitelist, blacklist })).toBe(expected)
    })
  }

  // A-9 regression, stated as the scenario rather than the truth-table row.
  // Before G-A1 this answered 'safe': the blacklist-only shortcut ran even
  // though a whitelist was configured and had already failed to match.
  it('G-A1: a dropped VPN with both lists set is never green', () => {
    expect(classifyIP(NEITHER, { whitelist: WL, blacklist: BL })).not.toBe('safe')
  })

  it('declaring a whitelist means outside-it is never safe, whatever else is set', () => {
    for (const blacklist of [[], BL, ['198.51.100.0/24']]) {
      expect(classifyIP(NEITHER, { whitelist: WL, blacklist })).not.toBe('safe')
    }
  })
})

describe('IPMonitor honours the fixed classification end-to-end', () => {
  afterEach(() => vi.unstubAllGlobals())

  // G-A1 stopped this answering `safe`; G-A2 stopped it answering `unknown`,
  // which understated an observed deviation into the same amber bucket as
  // "nothing is configured at all".
  it('reports a whitelist miss as off_profile when a blacklist is also configured', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], blacklist: ['1.2.3.4'], confirmations: 1, ipMode: 'http' })
    mockIPs('5.6.7.8')
    await tick(m)
    expect(m.status.externalIP).toBe('5.6.7.8')
    expect(m.status.ipSafety).toBe('off_profile')
  })
})

// G-A3. A verdict that outlives the reading behind it is the same class of lie
// as the A-9 false green — and the moment it matters most is a VPN kill-switch,
// which drops the network and therefore the IP lookup at the same instant.
describe('IPMonitor staleness decay', () => {
  const offline = (): void => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  }

  afterEach(() => vi.unstubAllGlobals())

  function safeMonitor(staleAfter?: number): IPMonitor {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], confirmations: 1, ipMode: 'http', staleAfter })
    return m
  }

  it('a single failure does not flip the badge — transient blips are not news', async () => {
    const m = safeMonitor()
    mockIPs('10.8.0.5')
    await tick(m)
    offline()
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')
    expect(m.status.stale).toBe(false)
    expect(m.status.consecutiveFailures).toBe(1)
  })

  it('decays the verdict to unknown once the failures reach the threshold', async () => {
    const m = safeMonitor()
    mockIPs('10.8.0.5')
    await tick(m)
    offline()
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')   // 1 of 2 — still holding
    await tick(m)
    expect(m.status.ipSafety).toBe('unknown')
    expect(m.status.stale).toBe(true)
    expect(m.status.consecutiveFailures).toBe(2)
  })

  it('keeps showing the last known address — the decay re-labels, it does not erase', async () => {
    const m = safeMonitor(1)
    mockIPs('10.8.0.5')
    await tick(m)
    offline()
    await tick(m)
    expect(m.status.stale).toBe(true)
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.error).toBeTruthy()
  })

  // The decay is deliberately uniform: holding a red alarm on a reading we can
  // no longer confirm is the same dishonesty as holding a green one.
  it('decays an exposed verdict too', async () => {
    const m = new IPMonitor()
    m.configure({ blacklist: ['203.0.113.0/24'], confirmations: 1, ipMode: 'http', staleAfter: 2 })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')
    offline()
    await tick(m); await tick(m)
    expect(m.status.ipSafety).toBe('unknown')
    expect(m.status.stale).toBe(true)
  })

  it('a successful read clears the decay and re-classifies', async () => {
    const m = safeMonitor(1)
    mockIPs('10.8.0.5')
    await tick(m)
    offline()
    await tick(m)
    expect(m.status.stale).toBe(true)
    mockIPs('10.8.0.5')
    await tick(m)
    expect(m.status.stale).toBe(false)
    expect(m.status.consecutiveFailures).toBe(0)
    expect(m.status.ipSafety).toBe('safe')
    expect(m.status.error).toBeNull()
  })

  it('honours a custom staleAfter and ignores junk values', async () => {
    const fast = safeMonitor(1)
    mockIPs('10.8.0.5')
    await tick(fast)
    offline()
    await tick(fast)
    expect(fast.status.stale).toBe(true)

    const dflt = safeMonitor()
    dflt.configure({ staleAfter: 0 })      // rejected → default 2 stands
    mockIPs('10.8.0.5')
    await tick(dflt)
    offline()
    await tick(dflt)
    expect(dflt.status.stale).toBe(false)
    await tick(dflt)
    expect(dflt.status.stale).toBe(true)
  })

  // The threshold is deliberately tighter than `confirmations`: slow promotion
  // is safe, slow expiry is not.
  it('expires faster than it promotes', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], ipMode: 'http' })   // both at defaults
    mockIPs('10.8.0.5')
    await tick(m)
    offline()
    await tick(m); await tick(m)
    expect(m.status.stale).toBe(true)        // 2 failures is enough to expire
  })

  // Same branch, second symptom: the verdict is a pure function of (address,
  // lists), so a list edit must move the badge without waiting for the address
  // to change. It used to sit on the old verdict indefinitely.
  it('re-classifies on an unchanged address after the lists are edited', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], confirmations: 1, ipMode: 'http' })
    mockIPs('10.8.0.5')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')

    m.configure({ whitelist: ['192.0.2.0/24'] })   // operator narrows the safe list
    await tick(m)
    expect(m.status.externalIP).toBe('10.8.0.5')
    expect(m.status.ipSafety).toBe('off_profile')
  })

  it('settling does not count as a failure', async () => {
    const m = new IPMonitor()
    m.configure({ whitelist: ['10.8.0.0/24'], confirmations: 3, ipMode: 'http', staleAfter: 2 })
    mockIPs('10.8.0.5', '203.0.113.1', '203.0.113.1')
    await tick(m)
    await tick(m); await tick(m)
    expect(m.status.settling).toBe(true)
    expect(m.status.consecutiveFailures).toBe(0)
    expect(m.status.stale).toBe(false)
  })
})

// G-A5. Before the shared matcher, `ipInCIDR` compared IPv6 by string equality
// against the network part, so a v6 whitelist could never match. That dropped a
// v6 egress into A-5 (whitelist-only) or — with a v4-only blacklist — into the
// A-3 fall-through, which answers green. The A-9 fix alone did not reach v6.
describe('IPMonitor over IPv6', () => {
  afterEach(() => vi.unstubAllGlobals())

  function v6Monitor(opts: Record<string, unknown>): IPMonitor {
    const m = new IPMonitor()
    m.configure({ confirmations: 1, ipMode: 'http', ...opts })
    return m
  }

  it('a v6 whitelist actually matches now', async () => {
    const m = v6Monitor({ whitelist: ['2001:db8::/32'] })
    mockIPs('2001:db8:0:1::5')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')
  })

  it('a v6 blacklist hit is exposed', async () => {
    const m = v6Monitor({ blacklist: ['2001:db8:dead::/48'] })
    mockIPs('2001:db8:dead:beef::1')
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')
  })

  it('outside a v6 whitelist is not safe — A-5 over v6', async () => {
    const m = v6Monitor({ whitelist: ['2001:db8::/32'] })
    mockIPs('2001:db9::1')
    await tick(m)
    expect(m.status.ipSafety).toBe('off_profile')
  })

  // A-9 over v6: both lists set, the address hits neither.
  it('A-9 over v6 is not green either', async () => {
    const m = v6Monitor({ whitelist: ['2001:db8::/32'], blacklist: ['2001:dead::/32'] })
    mockIPs('2001:beef::1')
    await tick(m)
    expect(m.status.ipSafety).toBe('off_profile')
  })

  // The old family guard returned false on a mismatch, so a v6 egress against a
  // v4-only blacklist took the A-3 fall-through and reported green.
  it('a v6 egress against a v4-only whitelist is not green', async () => {
    const m = v6Monitor({ whitelist: ['10.8.0.0/24'] })
    mockIPs('2001:db8::1')
    await tick(m)
    expect(m.status.ipSafety).toBe('off_profile')
  })

  it('an IPv4-mapped reading still matches the operator\'s v4 whitelist', async () => {
    const m = v6Monitor({ whitelist: ['10.8.0.0/24'] })
    mockIPs('::ffff:10.8.0.5')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')
  })

  it('an equivalent v6 notation in the list still matches', async () => {
    const m = v6Monitor({ whitelist: ['2001:0db8:0000:0000:0000:0000:0000:0001'] })
    mockIPs('2001:db8::1')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')
  })
})

// G-A2. Three states could not encode nine cells, so two of them lied:
// `presumed_safe` was reported as `safe` (an inference wearing a fact's solid
// green) and `off_profile` as `unknown` (an observed deviation filed as missing
// information). RedLog never blocks, so the badge IS the intervention — an
// understated verdict is not a cosmetic problem.
describe('the five verdicts', () => {
  const WL = ['10.8.0.0/24']
  const BL = ['1.2.3.4']

  it('separates a verified exit from a merely un-incriminating one', () => {
    expect(classifyIP('10.8.0.5', { whitelist: WL, blacklist: [] })).toBe('safe')
    expect(classifyIP('5.6.7.8', { whitelist: [], blacklist: BL })).toBe('presumed_safe')
  })

  it('separates an observed deviation from having no information', () => {
    expect(classifyIP('5.6.7.8', { whitelist: WL, blacklist: [] })).toBe('off_profile')
    expect(classifyIP('5.6.7.8', { whitelist: [], blacklist: [] })).toBe('unknown')
  })

  it('a blacklist hit still outranks everything', () => {
    expect(classifyIP('1.2.3.4', { whitelist: WL, blacklist: BL })).toBe('exposed')
    expect(classifyIP('1.2.3.4', { whitelist: ['1.2.3.4'], blacklist: BL })).toBe('exposed')
  })

  it('carries the §3 tier so no surface has to re-derive it from the name', () => {
    expect(verdictAuthority('safe')).toBe('fact')
    expect(verdictAuthority('off_profile')).toBe('fact')
    expect(verdictAuthority('exposed')).toBe('fact')
    // The whole reason this verdict exists.
    expect(verdictAuthority('presumed_safe')).toBe('inferred')
    // `unknown` asserts nothing, so it makes no claim to tier.
    expect(verdictAuthority('unknown')).toBeNull()
  })
})

// A-6: the verdict is `exposed` and correct, but a red badge looks like every
// other red badge — the operator would never learn their config contradicts
// itself. Reported alongside the verdict, not as one: it says something about
// the CONFIG, not about where the operator is.
describe('A-6 list conflict', () => {
  const both = { whitelist: ['203.0.113.0/24'], blacklist: ['203.0.113.0/24'] }

  it('flags an address that matches both lists', () => {
    expect(hasListConflict('203.0.113.9', both)).toBe(true)
    expect(classifyIP('203.0.113.9', both)).toBe('exposed')
  })

  it('does not flag an address that matches only one', () => {
    expect(hasListConflict('10.8.0.5', { whitelist: ['10.8.0.0/24'], blacklist: ['1.2.3.4'] })).toBe(false)
    expect(hasListConflict('1.2.3.4', { whitelist: ['10.8.0.0/24'], blacklist: ['1.2.3.4'] })).toBe(false)
  })

  it('reaches the status the UI reads', async () => {
    const m = new IPMonitor()
    m.configure({ ...both, confirmations: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.ipSafety).toBe('exposed')
    expect(m.status.listConflict).toBe(true)
  })

  it('clears once the address stops matching both', async () => {
    const m = new IPMonitor()
    m.configure({ ...both, confirmations: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.listConflict).toBe(true)
    mockIPs('198.51.100.5')
    await tick(m)
    expect(m.status.listConflict).toBe(false)
  })
})

// G-A4. `internalIP` was collected, displayed, and never judged — so a laptop
// that silently reassociated to a guest SSID mid-engagement read exactly like
// one still on the client VLAN. The external verdict cannot catch it: the
// egress can be perfectly fine while you are on the wrong network.
describe('LAN profile — the internal address gets a verdict', () => {
  afterEach(() => vi.unstubAllGlobals())

  // No new vocabulary: the same classifier with the profile as the whitelist
  // and no blacklist, so only three of the nine cells are reachable.
  it('reuses the verdict machinery rather than inventing a LAN one', () => {
    const onVlan = { whitelist: ['10.10.20.0/24'], blacklist: [] }
    expect(classifyIP('10.10.20.55', onVlan)).toBe('safe')
    expect(classifyIP('192.168.1.55', onVlan)).toBe('off_profile')
    expect(classifyIP('192.168.1.55', { whitelist: [], blacklist: [] })).toBe('unknown')
  })

  it('an unconfigured profile claims nothing', async () => {
    const m = new IPMonitor()
    m.configure({ confirmations: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.lanSafety).toBe('unknown')
  })

  it('judges the internal address independently of the external one', async () => {
    const m = new IPMonitor()
    // Egress verified fine; the LAN is where the problem is.
    m.configure({ whitelist: ['203.0.113.0/24'], lanProfile: ['10.10.20.0/24'], confirmations: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    expect(m.status.ipSafety).toBe('safe')
    expect(['safe', 'off_profile']).toContain(m.status.lanSafety)
  })

  it('re-derives on every poll, so editing the profile moves the verdict', async () => {
    const m = new IPMonitor()
    m.configure({ confirmations: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    const internal = m.status.internalIP
    expect(m.status.lanSafety).toBe('unknown')

    // Declare a profile that cannot match whatever this machine is on.
    m.configure({ lanProfile: ['198.51.100.0/24'] })
    await tick(m)
    expect(m.status.lanSafety).toBe(internal ? 'off_profile' : 'unknown')
  })

  // The internal address is a LOCAL read of the network interfaces. Losing it
  // because the INTERNET died is exactly backwards: dropping off the client
  // VLAN is more likely when the network is misbehaving.
  it('survives a failed external lookup — nothing about it expired', async () => {
    const m = new IPMonitor()
    m.configure({ lanProfile: ['198.51.100.0/24'], confirmations: 1, staleAfter: 1, ipMode: 'http' })
    mockIPs('203.0.113.9')
    await tick(m)
    const before = { ip: m.status.internalIP, lan: m.status.lanSafety }

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await tick(m)
    expect(m.status.stale).toBe(true)
    expect(m.status.ipSafety).toBe('unknown')     // the EXTERNAL verdict expired
    expect(m.status.internalIP).toBe(before.ip)   // the local read did not
    expect(m.status.lanSafety).toBe(before.lan)
  })
})
