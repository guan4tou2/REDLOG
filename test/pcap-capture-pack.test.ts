import { describe, it, expect } from 'vitest'
import { loadPlugins } from '../src/core/plugins/loader'

// Guards the bundled pcap-capture producer manifest: it must load through the
// real loader as an active, declarative capture pack (the privileged tcpdump
// invocation lives in its hook, run out-of-process — nothing here executes it).
describe('pcap-capture pack', () => {
  const pack = () => {
    const p = loadPlugins().find((x) => x.manifest.id === 'pcap-capture')
    if (!p) throw new Error('pcap-capture pack not found on disk')
    return p
  }

  it('loads as an active, declarative bundled capture producer', () => {
    const p = pack()
    expect(p.status).toBe('active')
    expect(p.tier).toBe('declarative') // pure capture contribution, no 🔴 code
    expect(p.source).toBe('bundled')
    expect(p.error).toBeFalsy()
  })

  it('declares a scanner capture with a hook and manual (elevated) install', () => {
    const cap = pack().manifest.contributes?.capture
    // Two capture options: tcpdump (unix) and tshark (Windows/npcap).
    expect(cap?.length).toBe(2)
    const tcpdump = cap?.find((c) => c.hookFile === 'hooks/pcap-capture.sh')
    expect(tcpdump).toMatchObject({ agentType: 'scanner', installMethod: 'manual' })
    expect(tcpdump?.requires).toContain('tcpdump')
    // The unix install step must be elevated — capture needs root/CAP_NET_RAW.
    expect(JSON.stringify(tcpdump?.manualSteps)).toMatch(/sudo/)
    const tshark = cap?.find((c) => c.hookFile === 'hooks/pcap-capture.ps1')
    expect(tshark?.requires).toContain('tshark')
    expect(tshark?.emits).toContain('packet_flow')
  })
})

describe('transparent-proxy pack', () => {
  // Removed: it rewrote this host's nat rules as root to capture tools that
  // ignore HTTP_PROXY. The operator runs their own proxy.
  it('is not shipped', () => {
    expect(loadPlugins().find((x) => x.manifest.id === 'transparent-proxy')).toBeUndefined()
  })
})
