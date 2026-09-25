import { describe, it, expect } from 'vitest'
import { whoHoldsPort, type PortProbe } from '../src/main/services/port-holder'

// What the operator is told when the capture port is already taken.
//
// mitmdump's own answer was a multi-line startup dump ending in a localised
// winsock error and a suggestion to pass `--mode regular@8082` — a mitmproxy
// flag, not a RedLog setting — so it named neither the holder nor the fact
// that the port is the operator's to change. On the machine this was found
// on, the holder was Burp Suite, whose default listener is 8080, which was
// also RedLog's default.
const probe = (free: boolean, holder: string | null = null): PortProbe => ({
  free: async () => free,
  holder: async () => holder
})

describe('whoHoldsPort', () => {
  it('says nothing when the endpoint is free', async () => {
    expect(await whoHoldsPort({ host: '127.0.0.1', port: 6661 }, probe(true))).toBeNull()
  })

  it('names the holder and the setting that moves the port', async () => {
    const msg = await whoHoldsPort({ host: '127.0.0.1', port: 8080 }, probe(false, 'BurpSuite.exe (PID 35632)'))
    expect(msg).toContain('127.0.0.1:8080')
    expect(msg).toContain('BurpSuite.exe (PID 35632)')
    expect(msg).toMatch(/Settings/)
  })

  it('still reports the clash when the holder cannot be named', async () => {
    const msg = await whoHoldsPort({ host: '0.0.0.0', port: 9090 }, probe(false, null))
    expect(msg).toContain('0.0.0.0:9090')
    expect(msg).toContain('already in use')
    // No dangling "by" with nothing after it.
    expect(msg).not.toMatch(/\bby\s*\./)
  })
})
