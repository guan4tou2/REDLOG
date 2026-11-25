import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NetworkInterfaceInfo } from 'os'

// The OPSEC monitor (src/main/services/opsec-state.ts) against scripted probes
// and fake time. Two things are pinned here:
//
//   #885  A DNS probe that fails is not a reading. It used to come back as an
//         empty list, so a slow PowerShell was recorded as the resolvers
//         disappearing and returning.
//   #880  On Windows an interface's name is whatever the tunnel's config file
//         was called; the adapter description is what says it is a VPN.
//
// The platform is forced per test, so both branches run on every CI leg.

const h = vi.hoisted(() => ({
  /** What the DNS probe prints, or 'fail' for a non-zero exit / timeout. */
  dns: [] as string[] | 'fail',
  /** What Get-NetAdapter returns, or 'fail'. */
  adapters: [] as Array<{ name: string; description: string }> | 'fail',
  ifaces: {} as Record<string, Array<Partial<NetworkInterfaceInfo>>>,
  commands: [] as string[]
}))

vi.mock('child_process', () => ({
  exec: (cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    h.commands.push(cmd)
    if (cmd.includes('Get-NetAdapter')) {
      return h.adapters === 'fail' ? cb(new Error('timed out'), '') : cb(null, JSON.stringify(h.adapters))
    }
    if (h.dns === 'fail') return cb(new Error('timed out'), '')
    const body = cmd.includes('resolv.conf') ? h.dns.map((s) => `nameserver ${s}`).join('\n') : h.dns.join('\n')
    return cb(null, body)
  }
}))

vi.mock('os', () => ({
  networkInterfaces: () => h.ifaces,
  hostname: () => 'host'
}))

import { configureOpsecMonitor, startOpsecMonitor, stopOpsecMonitor, setVpnAdapters, type OpsecStateDelta } from '../src/main/services/opsec-state'
import { DEFAULT_VPN_ADAPTERS } from '../src/core/config'

const POLL = 30_000
const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value: p, configurable: true }) }
const up = (address: string): Array<Partial<NetworkInterfaceInfo>> => [{ address, family: 'IPv4', internal: false, mac: '02:00:00:00:00:01' }]
const describeRuns = (): number => h.commands.filter((c) => c.includes('Get-NetAdapter')).length

let events: OpsecStateDelta[]
/** Start the monitor and let its seeding poll finish. */
async function start(): Promise<void> {
  startOpsecMonitor()
  await vi.advanceTimersByTimeAsync(0)
}
async function polls(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(POLL)
}

beforeEach(() => {
  vi.useFakeTimers()
  events = []
  h.dns = ['10.0.0.1', '10.0.0.2']
  h.adapters = [{ name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6E AX211 160MHz' }]
  h.ifaces = { 'Wi-Fi': up('192.168.1.10') }
  h.commands = []
  setVpnAdapters(DEFAULT_VPN_ADAPTERS)
  configureOpsecMonitor((delta) => { events.push(delta) })
})

afterEach(() => {
  stopOpsecMonitor()
  vi.useRealTimers()
  setPlatform(realPlatform)
})

describe('a DNS probe that fails is not a reading (#885)', () => {
  it('records nothing while the probe fails and nothing when it works again', async () => {
    setPlatform('win32')
    await start()
    h.dns = 'fail'
    await polls(10)
    h.dns = ['10.0.0.1', '10.0.0.2']
    await polls(5)
    expect(events).toEqual([])
  })

  it('does the same where the resolvers are read from a file', async () => {
    setPlatform('linux')
    await start()
    h.dns = 'fail'
    await polls(10)
    h.dns = ['10.0.0.1', '10.0.0.2']
    await polls(5)
    expect(events).toEqual([])
  })

  it('still records a change that holds for three polls', async () => {
    setPlatform('win32')
    await start()
    h.dns = ['172.16.0.53']
    await polls(2)
    expect(events).toEqual([])
    await polls(1)
    expect(events).toEqual([{ dns: { from: ['10.0.0.1', '10.0.0.2'], to: ['172.16.0.53'] } }])
  })

  it('a failed poll neither counts towards a pending change nor cancels it', async () => {
    setPlatform('win32')
    await start()
    h.dns = ['172.16.0.53']
    await polls(2)
    h.dns = 'fail'
    await polls(4)
    expect(events).toEqual([])
    h.dns = ['172.16.0.53']
    await polls(1)
    expect(events).toEqual([{ dns: { from: ['10.0.0.1', '10.0.0.2'], to: ['172.16.0.53'] } }])
  })

  it('records the resolvers really going away: the probe ran and listed none', async () => {
    setPlatform('win32')
    await start()
    h.dns = []
    await polls(3)
    expect(events).toEqual([{ dns: { from: ['10.0.0.1', '10.0.0.2'], to: [] } }])
  })

  it('adopts the first reading silently when the probe failed at the start', async () => {
    setPlatform('win32')
    h.dns = 'fail'
    await start()
    await polls(2)
    h.dns = ['10.0.0.1', '10.0.0.2']
    await polls(5)
    expect(events).toEqual([])
    h.dns = ['172.16.0.53']
    await polls(3)
    expect(events).toEqual([{ dns: { from: ['10.0.0.1', '10.0.0.2'], to: ['172.16.0.53'] } }])
  })
})

describe('a Windows tunnel is recognised by its adapter description (#880)', () => {
  it('a WireGuard tunnel named after its config file is a VPN', async () => {
    setPlatform('win32')
    await start()
    h.adapters = [...(h.adapters as []), { name: 'wt0', description: 'WireGuard Tunnel' }]
    h.ifaces = { ...h.ifaces, wt0: up('10.8.0.2') }
    await polls(1)
    expect(events).toEqual([{ vpn: { from: [], to: ['wt0'] } }])
  })

  it('so is one that Windows gave a localised default name', async () => {
    setPlatform('win32')
    h.adapters = [...(h.adapters as []), { name: '乙太網路 3', description: 'Fortinet SSL VPN Virtual Ethernet Adapter' }]
    await start()
    h.ifaces = { ...h.ifaces, '乙太網路 3': up('10.212.134.5') }
    await polls(1)
    expect(events).toEqual([{ vpn: { from: [], to: ['乙太網路 3'] } }])
  })

  it('the default patterns do not take ordinary adapters for a VPN', async () => {
    setPlatform('win32')
    h.adapters = [
      { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6E AX211 160MHz' },
      { name: 'vEthernet (Default Switch)', description: 'Hyper-V Virtual Ethernet Adapter #2' },
      { name: 'VMware Network Adapter VMnet8', description: 'VMware Virtual Ethernet Adapter for VMnet8' },
      { name: 'Ethernet', description: 'Realtek PCIe GbE Family Controller' }
    ]
    await start()
    h.ifaces = {
      ...h.ifaces,
      'vEthernet (Default Switch)': up('172.20.0.1'),
      'VMware Network Adapter VMnet8': up('192.168.80.1'),
      Ethernet: up('192.168.1.11')
    }
    await polls(2)
    expect(events).toEqual([])
  })

  it('asks for the descriptions at the start and when the interfaces change, not on every poll', async () => {
    setPlatform('win32')
    await start()
    expect(describeRuns()).toBe(1)
    await polls(20)
    expect(describeRuns()).toBe(1)
    h.ifaces = { ...h.ifaces, wt0: up('10.8.0.2') }
    await polls(1)
    expect(describeRuns()).toBe(2)
  })

  it('a tunnel that was up all along is not reported as coming up when the descriptions arrive late', async () => {
    setPlatform('win32')
    h.adapters = 'fail'
    h.ifaces = { ...h.ifaces, wt0: up('10.8.0.2') }
    await start()
    await polls(5)
    expect(describeRuns()).toBe(1) // a failure is not retried on every poll
    h.adapters = [{ name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6E AX211 160MHz' }, { name: 'wt0', description: 'WireGuard Tunnel' }]
    await polls(20) // past the ten-minute retry
    expect(describeRuns()).toBe(2)
    expect(events).toEqual([])
    // and from here it is tracked: taking the tunnel down is an event
    const { wt0: _gone, ...rest } = h.ifaces
    h.ifaces = rest
    await polls(1)
    expect(events).toEqual([{ vpn: { from: ['wt0'], to: [] } }])
  })

  it('does not ask on other platforms, where the name is what there is', async () => {
    setPlatform('linux')
    await start()
    h.ifaces = { ...h.ifaces, wg0: up('10.8.0.2') }
    await polls(1)
    expect(describeRuns()).toBe(0)
    expect(events).toEqual([{ vpn: { from: [], to: ['wg0'] } }])
  })
})
