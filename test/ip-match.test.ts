// The shared address matcher (G-A5). Both monitors route every IP decision
// through this, so a gap here is a gap in the whole alert subsystem.

import { describe, it, expect } from 'vitest'
import { ipInCIDR, parseIPv4, parseIPv6, ipFamily, isIPLiteral } from '../src/core/ip-match'

const hex = (b: Uint8Array | null): string =>
  b ? Array.from(b).map((n) => n.toString(16).padStart(2, '0')).join('') : 'null'

describe('parseIPv6', () => {
  const cases: Array<[string, string]> = [
    ['::', '00000000000000000000000000000000'],
    ['::1', '00000000000000000000000000000001'],
    ['2001:db8::1', '20010db8000000000000000000000001'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '20010db8000000000000000000000001'],
    ['fe80::1%en0', 'fe800000000000000000000000000001'],       // zone id stripped
    ['[2001:db8::1]', '20010db8000000000000000000000001'],     // URL brackets stripped
    ['::ffff:192.0.2.1', '00000000000000000000ffffc0000201'],  // embedded v4
    ['1:2:3:4:5:6:7:8', '00010002000300040005000600070008']
  ]
  for (const [input, expected] of cases) {
    it(`${input}`, () => expect(hex(parseIPv6(input))).toBe(expected))
  }

  const bad = ['2001:db8::1::2', '2001:db8:::1', 'gggg::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1.2.3.4', '']
  for (const input of bad) {
    it(`rejects ${input || '(empty)'}`, () => expect(parseIPv6(input)).toBeNull())
  }

  it('rejects an embedded v4 that is not last', () => {
    expect(parseIPv6('::192.0.2.1:1')).toBeNull()
  })
})

describe('parseIPv4', () => {
  it('parses a dotted quad', () => expect(parseIPv4('10.8.0.5')).toBe(0x0a080005))
  it('parses the broadcast address without sign trouble', () => expect(parseIPv4('255.255.255.255')).toBe(4294967295))
  it('rejects an out-of-range octet', () => expect(parseIPv4('999.1.1.1')).toBeNull())
  it('rejects a short quad', () => expect(parseIPv4('10.8.0')).toBeNull())
})

describe('ipFamily / isIPLiteral', () => {
  it('classifies both families', () => {
    expect(ipFamily('10.8.0.5')).toBe(4)
    expect(ipFamily('2001:db8::1')).toBe(6)
  })

  // The form providers actually return; an operator whose whitelist says
  // 10.8.0.0/24 means it to match.
  it('reports an IPv4-mapped IPv6 address as IPv4', () => {
    expect(ipFamily('::ffff:10.8.0.5')).toBe(4)
    expect(ipInCIDR('::ffff:10.8.0.5', '10.8.0.0/24')).toBe(true)
  })

  it('a hostname is not an IP literal — this is what routed v6 to the domain matcher', () => {
    expect(isIPLiteral('example.com')).toBe(false)
    expect(isIPLiteral('2001:db8::1')).toBe(true)
    expect(isIPLiteral('10.8.0.5')).toBe(true)
  })
})

describe('ipInCIDR — IPv4', () => {
  it('matches inside the prefix', () => expect(ipInCIDR('192.168.1.55', '192.168.1.0/24')).toBe(true))
  it('rejects outside the prefix', () => expect(ipInCIDR('192.168.2.55', '192.168.1.0/24')).toBe(false))
  it('/32 is a single host', () => {
    expect(ipInCIDR('10.0.0.1', '10.0.0.1/32')).toBe(true)
    expect(ipInCIDR('10.0.0.2', '10.0.0.1/32')).toBe(false)
  })
  it('/0 matches everything', () => expect(ipInCIDR('8.8.8.8', '0.0.0.0/0')).toBe(true))
  it('a bare address is exact equality', () => {
    expect(ipInCIDR('10.0.0.1', '10.0.0.1')).toBe(true)
    expect(ipInCIDR('10.0.0.2', '10.0.0.1')).toBe(false)
  })
  it('matches high addresses that overflow a signed shift', () => {
    expect(ipInCIDR('255.255.255.254', '255.255.255.0/24')).toBe(true)
  })
})

describe('ipInCIDR — IPv6 (the G-A5 defect)', () => {
  // Every one of these answered false before: v6 was compared by string
  // equality against the network part of the CIDR.
  it('matches inside a /32', () => expect(ipInCIDR('2001:db8::1', '2001:db8::/32')).toBe(true))
  it('matches inside a /64', () => expect(ipInCIDR('2001:db8:0:1::dead', '2001:db8:0:1::/64')).toBe(true))
  it('rejects a neighbouring /64', () => expect(ipInCIDR('2001:db8:0:2::dead', '2001:db8:0:1::/64')).toBe(false))
  it('rejects outside the /32', () => expect(ipInCIDR('2001:db9::1', '2001:db8::/32')).toBe(false))
  it('/128 is a single host', () => {
    expect(ipInCIDR('2001:db8::1', '2001:db8::1/128')).toBe(true)
    expect(ipInCIDR('2001:db8::2', '2001:db8::1/128')).toBe(false)
  })
  it('/0 matches everything', () => expect(ipInCIDR('2001:db8::1', '::/0')).toBe(true))

  it('handles a prefix that is not a whole number of bytes', () => {
    expect(ipInCIDR('2001:db8:8000::1', '2001:db8:8000::/33')).toBe(true)
    expect(ipInCIDR('2001:db8:0::1', '2001:db8:8000::/33')).toBe(false)
  })

  // The second half of the defect: equivalent notations did not compare equal.
  it('compares parsed values, not strings', () => {
    expect(ipInCIDR('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1')).toBe(true)
    expect(ipInCIDR('2001:DB8::1', '2001:db8::1')).toBe(true)
  })
})

describe('ipInCIDR — refuses to guess', () => {
  it('a family mismatch never matches', () => {
    expect(ipInCIDR('10.8.0.5', '2001:db8::/32')).toBe(false)
    expect(ipInCIDR('2001:db8::1', '10.8.0.0/24')).toBe(false)
  })

  // This decides whether to raise an alert, so junk must not accidentally match.
  it('malformed input is false, not a wildcard', () => {
    expect(ipInCIDR('not-an-ip', '10.0.0.0/8')).toBe(false)
    expect(ipInCIDR('10.0.0.1', 'garbage/8')).toBe(false)
    expect(ipInCIDR('10.0.0.1', '10.0.0.0/abc')).toBe(false)
    expect(ipInCIDR('10.0.0.1', '10.0.0.0/33')).toBe(false)
    expect(ipInCIDR('2001:db8::1', '2001:db8::/129')).toBe(false)
    expect(ipInCIDR('999.1.1.1', '999.1.1.0/24')).toBe(false)
  })
})
