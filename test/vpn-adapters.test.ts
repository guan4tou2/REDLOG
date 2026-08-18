// network.vpnAdapters — the operator-editable list of interface-name patterns
// that decides which links count as "the tunnel is up".
//
// It is the only config field whose values are user-supplied REGEXES, so both
// halves matter: an enabled pattern has to match, and a broken pattern must not
// take the OPSEC poller down with it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VpnAdapter } from '../src/core/config'

const ifaceMock = vi.fn()

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: actual, networkInterfaces: () => ifaceMock(), hostname: () => 'test-host' }
})

// readOpsecState also probes DNS through a shell-out; answer it with nothing.
vi.mock('child_process', () => ({
  exec: (_cmd: string, _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, '')
}))

const { setVpnAdapters, readOpsecState } = await import('../src/main/services/opsec-state')
const { DEFAULT_VPN_ADAPTERS } = await import('../src/core/config')

/** One external IPv4 address on each named interface. */
function links(...names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }]
  }
  names.forEach((n, i) => {
    out[n] = [{ address: `10.9.${i}.2`, family: 'IPv4', internal: false, mac: `aa:bb:cc:00:00:0${i}` }]
  })
  return out
}

const adapter = (name: string, pattern: string, enabled = true): VpnAdapter => ({ name, pattern, enabled })

async function vpnFor(adapters: VpnAdapter[], ifaces: Record<string, unknown>): Promise<string[]> {
  setVpnAdapters(adapters)
  ifaceMock.mockReturnValue(ifaces)
  return (await readOpsecState()).vpnInterfaces
}

beforeEach(() => ifaceMock.mockReset())

describe('vpnAdapters — pattern matching', () => {
  it('an enabled pattern marks the matching interface as VPN', async () => {
    expect(await vpnFor([adapter('WireGuard', 'wireguard|^wg\\d')], links('wg0', 'en0'))).toEqual(['wg0'])
  })

  it('patterns are case-insensitive', async () => {
    expect(await vpnFor([adapter('Tailscale', 'tailscale')], links('Tailscale0'))).toEqual(['Tailscale0'])
  })

  it('a disabled adapter matches nothing', async () => {
    expect(await vpnFor([adapter('WireGuard', '^wg\\d', false)], links('wg0'))).toEqual([])
  })

  it('an empty adapter list means no interface is ever VPN', async () => {
    expect(await vpnFor([], links('wg0', 'utun3'))).toEqual([])
  })

  it('several adapters can match at once, and the result is sorted', async () => {
    const out = await vpnFor(
      [adapter('WireGuard', '^wg\\d'), adapter('macOS utun', '^utun')],
      links('utun3', 'wg0', 'en0')
    )
    expect(out).toEqual(['utun3', 'wg0'])
  })

  it('an interface with no external address is not counted, even if the name matches', async () => {
    ifaceMock.mockReturnValue({ wg0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: 'x' }] })
    setVpnAdapters([adapter('WireGuard', '^wg\\d')])
    expect((await readOpsecState()).vpnInterfaces).toEqual([])
  })

  it('an interface with an empty address list is skipped', async () => {
    ifaceMock.mockReturnValue({ wg0: [] })
    setVpnAdapters([adapter('WireGuard', '^wg\\d')])
    expect((await readOpsecState()).vpnInterfaces).toEqual([])
  })

  it('a malformed pattern is dropped instead of throwing — the poller keeps running', async () => {
    const out = await vpnFor(
      [adapter('broken', '([unclosed'), adapter('macOS utun', '^utun')],
      links('utun3')
    )
    expect(out).toEqual(['utun3'])
  })

  it('re-configuring replaces the previous pattern set rather than adding to it', async () => {
    expect(await vpnFor([adapter('WireGuard', '^wg\\d')], links('wg0', 'utun3'))).toEqual(['wg0'])
    expect(await vpnFor([adapter('macOS utun', '^utun')], links('wg0', 'utun3'))).toEqual(['utun3'])
  })
})

describe('the shipped adapter list recognises the common clients', () => {
  const NAMES: Array<[string, string]> = [
    ['WireGuard', 'wg0'],
    ['OpenVPN', 'tun0'],
    ['OpenVPN tap', 'tap0'],
    ['Tailscale', 'tailscale0'],
    ['NordVPN', 'nordlynx'],
    ['ProtonVPN', 'proton0'],
    ['macOS utun', 'utun4'],
    ['IPSec', 'ipsec0'],
    ['PPP', 'ppp0']
  ]

  for (const [client, iface] of NAMES) {
    it(`${client} (${iface})`, async () => {
      expect(await vpnFor(DEFAULT_VPN_ADAPTERS, links(iface, 'en0'))).toEqual([iface])
    })
  }

  it('does not mistake an ordinary wired/Wi-Fi interface for a tunnel', async () => {
    expect(await vpnFor(DEFAULT_VPN_ADAPTERS, links('en0', 'eth0', 'wlan0'))).toEqual([])
  })
})

describe('the rest of the OPSEC snapshot still comes back', () => {
  it('reports the primary MAC and hostname alongside the VPN list', async () => {
    setVpnAdapters(DEFAULT_VPN_ADAPTERS)
    ifaceMock.mockReturnValue(links('en0'))
    const state = await readOpsecState()
    expect(state.primaryMac).toBe('aa:bb:cc:00:00:00')
    expect(state.hostname).toBe('test-host')
  })

  it('skips the all-zero MAC of a virtual/loopback adapter', async () => {
    ifaceMock.mockReturnValue({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
      en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00' }]
    })
    setVpnAdapters([])
    expect((await readOpsecState()).primaryMac).toBeNull()
  })
})
