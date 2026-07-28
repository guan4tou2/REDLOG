import { describe, it, expect } from 'vitest'

// Test the pure matching logic extracted from ScopeMonitor without DB dependency

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o), 0) >>> 0
}

function matchesCIDR(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr
  const [net, bits] = cidr.split('/')
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
  return (ipToLong(ip) & mask) === (ipToLong(net) & mask)
}

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2))
  }
  return host === pattern
}

function getRootDomain(host: string): string {
  const parts = host.split('.')
  if (parts.length <= 2) return host
  return parts.slice(-2).join('.')
}

describe('CIDR matching', () => {
  it('matches exact IP', () => {
    expect(matchesCIDR('10.0.0.1', '10.0.0.1')).toBe(true)
    expect(matchesCIDR('10.0.0.2', '10.0.0.1')).toBe(false)
  })

  it('matches /24 range', () => {
    expect(matchesCIDR('192.168.1.1', '192.168.1.0/24')).toBe(true)
    expect(matchesCIDR('192.168.1.254', '192.168.1.0/24')).toBe(true)
    expect(matchesCIDR('192.168.2.1', '192.168.1.0/24')).toBe(false)
  })

  it('matches /16 range', () => {
    expect(matchesCIDR('10.10.5.1', '10.10.0.0/16')).toBe(true)
    expect(matchesCIDR('10.11.0.1', '10.10.0.0/16')).toBe(false)
  })

  it('matches /8 range', () => {
    expect(matchesCIDR('10.255.255.255', '10.0.0.0/8')).toBe(true)
    expect(matchesCIDR('11.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('matches /32 single host', () => {
    expect(matchesCIDR('10.0.0.1', '10.0.0.1/32')).toBe(true)
    expect(matchesCIDR('10.0.0.2', '10.0.0.1/32')).toBe(false)
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

describe('root domain extraction', () => {
  it('returns same for 2-part domain', () => {
    expect(getRootDomain('example.com')).toBe('example.com')
  })

  it('extracts root from subdomain', () => {
    expect(getRootDomain('api.example.com')).toBe('example.com')
  })

  it('extracts root from deep subdomain', () => {
    expect(getRootDomain('a.b.c.example.com')).toBe('example.com')
  })
})

describe('scope filtering logic', () => {
  const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

  function checkScope(
    target: string,
    targets: string[],
    excludeTargets: string[] = []
  ): { inScope: boolean; violation: boolean } {
    if (targets.length === 0) return { inScope: true, violation: false }

    const isExcluded = excludeTargets.some((ex) =>
      IP_RE.test(target) ? matchesCIDR(target, ex) : matchesDomain(target, ex)
    )
    if (isExcluded) return { inScope: false, violation: true }

    const isInScope = targets.some((t) =>
      IP_RE.test(target) ? matchesCIDR(target, t) : matchesDomain(target, t)
    )
    if (isInScope) return { inScope: true, violation: false }

    const isIP = IP_RE.test(target)
    if (!isIP) {
      const targetRoot = getRootDomain(target)
      const scopeRoots = new Set<string>()
      for (const t of targets) {
        if (IP_RE.test(t) || t.includes('/')) continue
        const domain = t.startsWith('*.') ? t.slice(2) : t
        scopeRoots.add(getRootDomain(domain))
      }
      if (!scopeRoots.has(targetRoot)) {
        return { inScope: false, violation: false }
      }
    }

    return { inScope: false, violation: true }
  }

  it('everything in scope when no targets configured', () => {
    expect(checkScope('anything.com', []).inScope).toBe(true)
  })

  it('in-scope target matches', () => {
    expect(checkScope('10.0.0.1', ['10.0.0.0/24']).inScope).toBe(true)
  })

  it('out-of-scope IP is a violation', () => {
    const result = checkScope('10.0.0.1', ['192.168.1.0/24'])
    expect(result.inScope).toBe(false)
    expect(result.violation).toBe(true)
  })

  it('unrelated domain is NOT a violation', () => {
    const result = checkScope('google.com', ['*.example.com'])
    expect(result.violation).toBe(false)
  })

  it('same-root out-of-scope IS a violation', () => {
    const result = checkScope('other.example.com', ['*.app.example.com'])
    expect(result.violation).toBe(true)
  })

  it('excluded target is a violation', () => {
    const result = checkScope('internal.example.com', ['*.example.com'], ['internal.example.com'])
    expect(result.inScope).toBe(false)
    expect(result.violation).toBe(true)
  })
})
