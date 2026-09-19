import { describe, it, expect } from 'vitest'
import { ipToLong, matchesScopePattern } from '../src/renderer/src/lib/timelineScopeMatch'

describe('ipToLong', () => {
  it('converts 0.0.0.0', () => expect(ipToLong('0.0.0.0')).toBe(0))
  it('converts 255.255.255.255', () => expect(ipToLong('255.255.255.255')).toBe(0xFFFFFFFF))
  it('converts 192.168.1.1', () => expect(ipToLong('192.168.1.1')).toBe(0xC0A80101))
  it('converts 10.0.0.1', () => expect(ipToLong('10.0.0.1')).toBe(0x0A000001))
})

describe('matchesScopePattern', () => {
  describe('exact match', () => {
    it('matches equal strings', () => expect(matchesScopePattern('example.com', 'example.com')).toBe(true))
    it('rejects different strings', () => expect(matchesScopePattern('foo.com', 'bar.com')).toBe(false))
    it('matches exact IP', () => expect(matchesScopePattern('10.0.0.1', '10.0.0.1')).toBe(true))
  })

  describe('wildcard domain', () => {
    it('matches subdomain', () => expect(matchesScopePattern('sub.example.com', '*.example.com')).toBe(true))
    it('matches bare domain', () => expect(matchesScopePattern('example.com', '*.example.com')).toBe(true))
    it('matches nested subdomain', () => expect(matchesScopePattern('a.b.example.com', '*.example.com')).toBe(true))
    it('rejects unrelated domain', () => expect(matchesScopePattern('other.com', '*.example.com')).toBe(false))
    it('rejects suffix overlap', () => expect(matchesScopePattern('notexample.com', '*.example.com')).toBe(false))
  })

  describe('CIDR', () => {
    it('matches IP in /24', () => expect(matchesScopePattern('192.168.1.42', '192.168.1.0/24')).toBe(true))
    it('rejects IP outside /24', () => expect(matchesScopePattern('192.168.2.1', '192.168.1.0/24')).toBe(false))
    it('matches /16', () => expect(matchesScopePattern('10.0.99.1', '10.0.0.0/16')).toBe(true))
    it('rejects /16', () => expect(matchesScopePattern('10.1.0.1', '10.0.0.0/16')).toBe(false))
    it('matches /32 (single host)', () => expect(matchesScopePattern('10.0.0.1', '10.0.0.1/32')).toBe(true))
    it('rejects non-IP target', () => expect(matchesScopePattern('example.com', '10.0.0.0/24')).toBe(false))
  })
})
