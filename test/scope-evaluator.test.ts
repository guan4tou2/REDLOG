import { describe, it, expect } from 'vitest'
import { evaluateScope, matchPattern, normalizeSubject } from '../src/core/scope-evaluator'

describe('normalizeSubject', () => {
  it('lowercases', () => {
    expect(normalizeSubject('EXAMPLE.COM')).toBe('example.com')
  })

  it('strips trailing dot', () => {
    expect(normalizeSubject('example.com.')).toBe('example.com')
  })

  it('strips port', () => {
    expect(normalizeSubject('example.com:8080')).toBe('example.com')
  })

  it('extracts hostname from URL', () => {
    expect(normalizeSubject('http://example.com/path?q=1')).toBe('example.com')
  })

  it('extracts hostname from URL with port', () => {
    expect(normalizeSubject('https://example.com:443/path')).toBe('example.com')
  })

  it('maps IPv4-mapped IPv6 to IPv4', () => {
    expect(normalizeSubject('::ffff:10.0.0.1')).toBe('10.0.0.1')
  })

  it('returns empty for empty input', () => {
    expect(normalizeSubject('')).toBe('')
  })
})

describe('matchPattern', () => {
  // --- Exact hostname ---
  it('exact hostname matches', () => {
    expect(matchPattern('example.com', 'example.com')).toBe(true)
  })

  it('case-insensitive', () => {
    expect(matchPattern('example.com', 'EXAMPLE.COM')).toBe(true)
  })

  it('no substring matching', () => {
    expect(matchPattern('notexample.com', 'example.com')).toBe(false)
  })

  it('no implicit subdomain', () => {
    expect(matchPattern('sub.example.com', 'example.com')).toBe(false)
  })

  // --- Wildcard ---
  it('wildcard matches subdomain', () => {
    expect(matchPattern('sub.example.com', '*.example.com')).toBe(true)
  })

  it('wildcard matches deep subdomain', () => {
    expect(matchPattern('a.b.example.com', '*.example.com')).toBe(true)
  })

  it('wildcard matches bare domain', () => {
    expect(matchPattern('example.com', '*.example.com')).toBe(true)
  })

  it('wildcard does not match unrelated', () => {
    expect(matchPattern('notexample.com', '*.example.com')).toBe(false)
  })

  // --- IPv4 CIDR ---
  it('IPv4 CIDR /24 in range', () => {
    expect(matchPattern('10.0.0.1', '10.0.0.0/24')).toBe(true)
  })

  it('IPv4 CIDR /24 boundary', () => {
    expect(matchPattern('10.0.0.255', '10.0.0.0/24')).toBe(true)
  })

  it('IPv4 CIDR /24 out of range', () => {
    expect(matchPattern('10.0.1.0', '10.0.0.0/24')).toBe(false)
  })

  it('IPv4 CIDR /0 matches all', () => {
    expect(matchPattern('192.168.1.1', '0.0.0.0/0')).toBe(true)
  })

  it('IPv4 CIDR /32 exact', () => {
    expect(matchPattern('10.0.0.5', '10.0.0.5/32')).toBe(true)
    expect(matchPattern('10.0.0.6', '10.0.0.5/32')).toBe(false)
  })

  it('IPv4 exact match (no CIDR)', () => {
    expect(matchPattern('10.0.0.1', '10.0.0.1')).toBe(true)
    expect(matchPattern('10.0.0.2', '10.0.0.1')).toBe(false)
  })

  // --- IPv6 ---
  it('IPv6 exact match', () => {
    expect(matchPattern('::1', '::1')).toBe(true)
  })

  it('IPv6 CIDR matches the complete prefix', () => {
    expect(matchPattern('fe80::1', 'fe80::1/64')).toBe(true)
    expect(matchPattern('fe80::2', 'fe80::1/64')).toBe(true)
    expect(matchPattern('fe81::1', 'fe80::1/64')).toBe(false)
    expect(matchPattern('2001:db8:0:1::9', '2001:db8::/48')).toBe(true)
    expect(matchPattern('2001:db9::1', '2001:db8::/48')).toBe(false)
  })

  it('IPv6 CIDR supports /0 and /128 boundaries', () => {
    expect(matchPattern('fd00::1', '::/0')).toBe(true)
    expect(matchPattern('2001:db8::1', '2001:db8::1/128')).toBe(true)
    expect(matchPattern('2001:db8::2', '2001:db8::1/128')).toBe(false)
  })

  it('rejects malformed IPv6 addresses and prefix lengths', () => {
    expect(matchPattern('2001:db8::1', '2001:db8::/129')).toBe(false)
    expect(matchPattern('2001:db8::1', '2001:db8::/-1')).toBe(false)
    expect(matchPattern('2001:db8::zz', '2001:db8::/64')).toBe(false)
  })

  // --- Malformed ---
  it('malformed CIDR bits > 32 does not match', () => {
    expect(matchPattern('10.0.0.1', '10.0.0.0/33')).toBe(false)
  })

  it('rejects IPv4 octets outside 0-255', () => {
    expect(matchPattern('10.0.0.1', '999.0.0.0/8')).toBe(false)
    expect(matchPattern('999.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('empty pattern matches nothing', () => {
    expect(matchPattern('example.com', '')).toBe(false)
  })

  it('hostname against CIDR does not match', () => {
    expect(matchPattern('example.com', '10.0.0.0/24')).toBe(false)
  })
})

describe('evaluateScope', () => {
  const policy = (targets: string[], excludeTargets: string[] = []) =>
    ({ targets, excludeTargets })

  // S1: Exact hostname
  it('S1: exact hostname in-scope', () => {
    const r = evaluateScope('example.com', policy(['example.com']))
    expect(r.status).toBe('in-scope')
    expect((r as { matchedBy: string }).matchedBy).toBe('example.com')
  })

  it('S1: case-insensitive', () => {
    expect(evaluateScope('EXAMPLE.COM', policy(['example.com'])).status).toBe('in-scope')
  })

  it('S1: no substring', () => {
    expect(evaluateScope('notexample.com', policy(['example.com'])).status).toBe('out-of-scope')
  })

  it('S1: no implicit subdomain', () => {
    expect(evaluateScope('sub.example.com', policy(['example.com'])).status).toBe('out-of-scope')
  })

  // S2: Wildcard
  it('S2: wildcard subdomain', () => {
    expect(evaluateScope('sub.example.com', policy(['*.example.com'])).status).toBe('in-scope')
  })

  it('S2: wildcard deep subdomain', () => {
    expect(evaluateScope('a.b.example.com', policy(['*.example.com'])).status).toBe('in-scope')
  })

  it('S2: wildcard includes bare domain', () => {
    expect(evaluateScope('example.com', policy(['*.example.com'])).status).toBe('in-scope')
  })

  it('S2: wildcard does not match unrelated', () => {
    expect(evaluateScope('notexample.com', policy(['*.example.com'])).status).toBe('out-of-scope')
  })

  // S3: CIDR
  it('S3: IPv4 CIDR in range', () => {
    expect(evaluateScope('10.0.0.1', policy(['10.0.0.0/24'])).status).toBe('in-scope')
  })

  it('S3: IPv4 CIDR boundary', () => {
    expect(evaluateScope('10.0.0.255', policy(['10.0.0.0/24'])).status).toBe('in-scope')
  })

  it('S3: IPv4 CIDR out of range', () => {
    expect(evaluateScope('10.0.1.0', policy(['10.0.0.0/24'])).status).toBe('out-of-scope')
  })

  // S4: Exclude wins
  it('S4: exclude overrides include', () => {
    const r = evaluateScope('dev.example.com', policy(['*.example.com'], ['dev.example.com']))
    expect(r.status).toBe('excluded')
  })

  it('S4: non-excluded still in-scope', () => {
    const r = evaluateScope('prod.example.com', policy(['*.example.com'], ['dev.example.com']))
    expect(r.status).toBe('in-scope')
  })

  // S5: Input normalization
  it('S5: strips port', () => {
    expect(evaluateScope('example.com:8080', policy(['example.com'])).status).toBe('in-scope')
  })

  it('S5: strips trailing dot', () => {
    expect(evaluateScope('example.com.', policy(['example.com'])).status).toBe('in-scope')
  })

  it('S5: extracts hostname from URL', () => {
    expect(evaluateScope('http://example.com/path', policy(['example.com'])).status).toBe('in-scope')
  })

  it('S5: IPv4-mapped IPv6', () => {
    expect(evaluateScope('::ffff:10.0.0.1', policy(['10.0.0.0/24'])).status).toBe('in-scope')
  })

  // S6: Malformed
  it('S6: empty subject → out-of-scope', () => {
    expect(evaluateScope('', policy(['example.com'])).status).toBe('out-of-scope')
  })

  it('S6: malformed CIDR bits → no match, no throw', () => {
    expect(evaluateScope('10.0.0.1', policy(['10.0.0.0/33'])).status).toBe('out-of-scope')
  })

  // No-scope
  it('no scope configured → no-scope', () => {
    expect(evaluateScope('anything', policy([])).status).toBe('no-scope')
  })

  it('no scope configured (empty both) → no-scope', () => {
    expect(evaluateScope('anything', policy([], [])).status).toBe('no-scope')
  })

  // Properties
  it('normalize does not change decision', () => {
    const subjects = ['Example.COM', 'example.com:443', 'example.com.', 'http://example.com/x']
    const p = policy(['example.com'])
    for (const s of subjects) {
      expect(evaluateScope(s, p).status).toBe('in-scope')
    }
  })

  it('case does not change decision', () => {
    const p = policy(['example.com', '10.0.0.0/24'])
    expect(evaluateScope('EXAMPLE.COM', p).status).toBe(evaluateScope('example.com', p).status)
  })
})
