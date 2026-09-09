import { describe, it, expect } from 'vitest'
import { matchesScope, hostInScope, hostOutOfScope } from '../src/renderer/src/lib/scope'

describe('scope classify (renderer display)', () => {
  it('matchesScope: bare host, wildcard, CIDR', () => {
    expect(matchesScope('acme.example.com', 'acme.example.com')).toBe(true)
    expect(matchesScope('acme.example.com', '*.example.com')).toBe(true)
    expect(matchesScope('example.com', '*.example.com')).toBe(true)     // apex matches its own wildcard
    expect(matchesScope('evil.com', '*.example.com')).toBe(false)
    expect(matchesScope('10.10.11.24', '10.10.0.0/16')).toBe(true)
    expect(matchesScope('10.20.11.24', '10.10.0.0/16')).toBe(false)
    expect(matchesScope('not-an-ip', '10.10.0.0/16')).toBe(false)
  })

  it('hostInScope: empty allow list = everything in scope', () => {
    expect(hostInScope('anything.com', [])).toBe(true)
  })

  it('hostInScope: allow list gates', () => {
    expect(hostInScope('acme.example.com', ['*.example.com'])).toBe(true)
    expect(hostInScope('bank.personal.com', ['*.example.com'])).toBe(false)
  })

  it('hostInScope: explicit exclude wins over allow', () => {
    expect(hostInScope('secret.example.com', ['*.example.com'], ['secret.example.com'])).toBe(false)
  })

  it('hostOutOfScope: never flags when no scope configured', () => {
    expect(hostOutOfScope('anything.com', [])).toBe(false)
    expect(hostOutOfScope('anything.com', [], [])).toBe(false)
  })

  it('hostOutOfScope: flags a host outside a configured allow list', () => {
    expect(hostOutOfScope('bank.personal.com', ['*.example.com'])).toBe(true)
    expect(hostOutOfScope('acme.example.com', ['*.example.com'])).toBe(false)
  })

  it('hostOutOfScope: an exclude alone makes a matched host out of scope', () => {
    // allow empty but an exclude set: excluded host is out, others still in
    expect(hostOutOfScope('tracker.evil.com', [], ['tracker.evil.com'])).toBe(true)
    expect(hostOutOfScope('acme.example.com', [], ['tracker.evil.com'])).toBe(false)
  })

  it('empty host is never out of scope', () => {
    expect(hostOutOfScope('', ['*.example.com'])).toBe(false)
    expect(hostInScope('', ['*.example.com'])).toBe(true)
  })
})
