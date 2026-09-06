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
    expect(cap?.length).toBe(1)
    expect(cap?.[0]).toMatchObject({ agentType: 'scanner', installMethod: 'manual' })
    expect(cap?.[0].hookFile).toBe('hooks/pcap-capture.sh')
    expect(cap?.[0].requires).toContain('tcpdump')
    // The install step must be elevated — capture needs root/CAP_NET_RAW.
    expect(JSON.stringify(cap?.[0].manualSteps)).toMatch(/sudo/)
  })
})

describe('transparent-proxy pack', () => {
  const pack = () => {
    const p = loadPlugins().find((x) => x.manifest.id === 'transparent-proxy')
    if (!p) throw new Error('transparent-proxy pack not found on disk')
    return p
  }

  it('loads as an active, declarative bundled capture producer', () => {
    const p = pack()
    expect(p.status).toBe('active')
    expect(p.tier).toBe('declarative')
    expect(p.source).toBe('bundled')
    expect(p.error).toBeFalsy()
  })

  it('declares an elevated mitmproxy transparent hook with up + down steps', () => {
    const cap = pack().manifest.contributes?.capture
    expect(cap?.length).toBe(1)
    expect(cap?.[0]).toMatchObject({ agentType: 'scanner', installMethod: 'manual' })
    expect(cap?.[0].hookFile).toBe('hooks/transparent-proxy.sh')
    expect(cap?.[0].requires).toContain('mitmdump')
    const steps = JSON.stringify(cap?.[0].manualSteps)
    expect(steps).toMatch(/sudo/)      // rewrites nat rules — needs root
    expect(steps).toMatch(/up/)        // start
    expect(steps).toMatch(/down/)      // teardown is offered, not left implicit
  })
})
