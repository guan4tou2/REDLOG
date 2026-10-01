// A capture RedLog cannot start, and what has to stay true about it.
//
// tcpdump needs root; the transparent proxy rewrites this host's nat rules.
// RedLog holds neither, so these producers run outside it — which means
// switching them off inside RedLog does not stop them. Two things follow, and
// both were wrong:
//
//   1. Unregistering deleted the capture outright, so a disabled source
//      vanished from detectHooks() and from capture-health together. The
//      screen then showed nothing for a redirect that was still up and still
//      landing events, because ingest does not consult the plugin registry.
//   2. The setup and teardown commands were computed in core and rendered by
//      no one, so the only way to undo an iptables redirect existed solely as
//      a TypeScript return value.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCapturePlugins, unregisterCapturePlugins, detectHooks, invalidateHooksCache
} from '../src/core/hooks-manager'

const ENTRIES = [
  {
    id: 'pcap-tcpdump',
    name: 'tcpdump → scanner.packet_flow',
    description: 'needs tcpdump',
    agentType: 'scanner',
    emits: ['packet_flow'],
    installMethod: 'manual' as const,
    hookFile: 'hooks/pcap.sh',
    manualSteps: [{ label: 'Capture', command: 'sudo hooks/pcap.sh eth0' }]
  }
]

const find = (id: string) => detectHooks().find((h) => h.id === id)

beforeEach(() => {
  unregisterCapturePlugins('t-pcap')
  invalidateHooksCache()
})

describe('a capture the operator runs themselves', () => {
  it('is listed once registered, namespaced under its plugin', () => {
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()
    const hook = find('t-pcap.pcap-tcpdump')
    expect(hook).toBeTruthy()
    expect(hook!.disabled).toBe(false)
  })

  it('stays listed when its plugin is switched off, flagged rather than erased', () => {
    // The whole point. Disabling does not kill tcpdump — it only stops RedLog
    // mentioning it, and a screen with no row reads as "this is not
    // happening".
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()
    unregisterCapturePlugins('t-pcap')
    invalidateHooksCache()

    const hook = find('t-pcap.pcap-tcpdump')
    expect(hook, 'a disabled capture must not disappear').toBeTruthy()
    expect(hook!.disabled).toBe(true)
  })

  it('keeps its commands while disabled, because that is when teardown is read', () => {
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()
    unregisterCapturePlugins('t-pcap')
    invalidateHooksCache()
    expect(find('t-pcap.pcap-tcpdump')!.manualSteps?.[0].command).toContain('sudo')
  })

  it('comes back live on re-enable, with no duplicate row', () => {
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()
    unregisterCapturePlugins('t-pcap')
    invalidateHooksCache()
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()

    const rows = detectHooks().filter((h) => h.id === 't-pcap.pcap-tcpdump')
    expect(rows).toHaveLength(1)
    expect(rows[0].disabled).toBe(false)
  })

  it('never claims to be installed, because RedLog cannot install it', () => {
    // `manual` means the operator runs it. Reporting "installed" for a thing
    // RedLog neither placed nor started is the lie the old enable switch told.
    registerCapturePlugins('t-pcap', '/tmp/t-pcap', ENTRIES)
    invalidateHooksCache()
    expect(find('t-pcap.pcap-tcpdump')!.installed).toBe(false)
  })
})

describe('built-in hooks', () => {
  it('carry teardown steps, which nothing used to render', () => {
    // mitmproxy's removal steps include dropping trust in its CA — the
    // longest-lived thing RedLog can leave on a machine, and the one nobody
    // remembers. They were computed for every hook and shown on no screen.
    const mitm = detectHooks().find((h) => h.id === 'mitmproxy')
    expect(mitm, 'mitmproxy must still be a built-in hook').toBeTruthy()
    const steps = mitm!.removalSteps ?? []
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.some((s) => /CA|certificate|憑證/i.test(s.label))).toBe(true)
  })
})
