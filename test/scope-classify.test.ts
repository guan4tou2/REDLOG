import { describe, it, expect } from 'vitest'
import { matchesScope, hostInScope } from '../src/renderer/src/lib/scope'

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

  it('empty host is in scope', () => {
    expect(hostInScope('', ['*.example.com'])).toBe(true)
  })
})
