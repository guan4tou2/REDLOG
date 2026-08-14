import { describe, it, expect } from 'vitest'
import { classifyDistance } from '../src/core/scope-monitor'
import { getRegistrableDomain } from '../src/core/public-suffix'
import { ipInCIDR } from '../src/core/ip-match'

// Unit coverage for the matching primitives, all driving the SHIPPED functions.
// This file used to carry local copies of `ipToLong`/`matchesCIDR`/`getRootDomain`
// and a re-implementation of the ladder. Every one of those copies eventually
// disagreed with the real thing — the ladder after G-B1/G-B3, the root-domain
// rule after G-B2, the CIDR matcher after G-A5 — so none of them are left.
// Exhaustive v6/v4 matcher coverage lives in `ip-match.test.ts`.

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2))
  }
  return host === pattern
}

describe('CIDR matching', () => {
  it('matches exact IP', () => {
    expect(ipInCIDR('10.0.0.1', '10.0.0.1')).toBe(true)
    expect(ipInCIDR('10.0.0.2', '10.0.0.1')).toBe(false)
  })

  it('matches /24 range', () => {
    expect(ipInCIDR('192.168.1.1', '192.168.1.0/24')).toBe(true)
    expect(ipInCIDR('192.168.1.254', '192.168.1.0/24')).toBe(true)
    expect(ipInCIDR('192.168.2.1', '192.168.1.0/24')).toBe(false)
  })

  it('matches /16 range', () => {
    expect(ipInCIDR('10.10.5.1', '10.10.0.0/16')).toBe(true)
    expect(ipInCIDR('10.11.0.1', '10.10.0.0/16')).toBe(false)
  })

  it('matches /8 range', () => {
    expect(ipInCIDR('10.255.255.255', '10.0.0.0/8')).toBe(true)
    expect(ipInCIDR('11.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('matches /32 single host', () => {
    expect(ipInCIDR('10.0.0.1', '10.0.0.1/32')).toBe(true)
    expect(ipInCIDR('10.0.0.2', '10.0.0.1/32')).toBe(false)
  })
})

describe('domain matching', () => {
  it('matches exact domain', () => {
    expect(matchesDomain('example.com', 'example.com')).toBe(true)
    expect(matchesDomain('other.com', 'example.com')).toBe(false)
  })

  it('matches wildcard subdomain', () => {
    expect(matchesDomain('api.example.com', '*.example.com')).toBe(true)
    expect(matchesDomain('deep.sub.example.com', '*.example.com')).toBe(true)
  })

  it('wildcard matches bare domain', () => {
    expect(matchesDomain('example.com', '*.example.com')).toBe(true)
  })

  it('wildcard does not match unrelated domain', () => {
    expect(matchesDomain('example.org', '*.example.com')).toBe(false)
  })
})

// Was a local last-two-labels copy. That rule shipped as the G-B2 defect, so the
// duplicate is gone and these now pin the real derivation. Full coverage of the
// suffix table lives in `public-suffix.test.ts`.
describe('registrable domain extraction', () => {
  it('returns same for 2-part domain', () => {
    expect(getRegistrableDomain('example.com')).toBe('example.com')
  })

  it('extracts root from subdomain', () => {
    expect(getRegistrableDomain('api.example.com')).toBe('example.com')
  })

  it('extracts root from deep subdomain', () => {
    expect(getRegistrableDomain('a.b.c.example.com')).toBe('example.com')
  })

  it('does not stop at a multi-label public suffix', () => {
    expect(getRegistrableDomain('a.b.c.example.co.uk')).toBe('example.co.uk')
  })
})

describe('scope filtering logic — the real classifyDistance', () => {
  const violates = (d: string): boolean => d === 'excluded' || d.startsWith('adjacent_')

  it('everything in scope when no targets configured', () => {
    expect(classifyDistance('anything.com', { targets: [], excludeTargets: [] })).toBe('in_scope')
  })

  it('in-scope target matches', () => {
    expect(classifyDistance('10.0.0.1', { targets: ['10.0.0.0/24'], excludeTargets: [] })).toBe('in_scope')
  })

  // Was 'out-of-scope IP is a violation'. A written CIDR states its own
  // boundary, so its complement is unrelated (D3), not adjacent (D2) — G-B3.
  it('an IP outside a stated CIDR is unrelated, not a violation', () => {
    const d = classifyDistance('10.0.0.1', { targets: ['192.168.1.0/24'], excludeTargets: [] })
    expect(d).toBe('unrelated')
    expect(violates(d)).toBe(false)
  })

  it('an IP in the same segment as a single-IP entry IS a violation — G-B1', () => {
    const d = classifyDistance('192.168.1.55', { targets: ['192.168.1.10'], excludeTargets: [] })
    expect(d).toBe('adjacent_subnet')
    expect(violates(d)).toBe(true)
  })

  it('unrelated domain is NOT a violation', () => {
    expect(classifyDistance('google.com', { targets: ['*.example.com'], excludeTargets: [] })).toBe('unrelated')
  })

  it('same-root out-of-scope IS a violation', () => {
    const d = classifyDistance('other.example.com', { targets: ['*.app.example.com'], excludeTargets: [] })
    expect(d).toBe('adjacent_domain')
    expect(violates(d)).toBe(true)
  })

  it('excluded target is a violation', () => {
    const d = classifyDistance('internal.example.com', {
      targets: ['*.example.com'],
      excludeTargets: ['internal.example.com']
    })
    expect(d).toBe('excluded')
    expect(violates(d)).toBe(true)
  })
})
