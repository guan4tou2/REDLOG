import { describe, expect, it } from 'vitest'
import { parseScopeInput } from '../src/renderer/src/lib/scopeInput'
import { matchPattern } from '../src/core/scope-evaluator'

// Spec 037: the create card takes a pasted scope. The parser decides what
// reaches `scope.targets`; anything the canonical evaluator could never match
// is reported back instead of being saved as a silent no-op.

describe('parseScopeInput', () => {
  it('splits on newlines, commas and whitespace, trimming empties', () => {
    const r = parseScopeInput('10.10.11.0/24, *.corp.local\n\n  dc01.corp.local\t10.0.0.5 ,,\r\n')
    expect(r.valid).toEqual(['10.10.11.0/24', '*.corp.local', 'dc01.corp.local', '10.0.0.5'])
    expect(r.invalid).toEqual([])
  })

  it('drops duplicates, case-insensitively, keeping the first spelling', () => {
    const r = parseScopeInput('Corp.Local\ncorp.local, 10.0.0.1 10.0.0.1\n10.0.0.0/8\n10.0.0.0/8')
    expect(r.valid).toEqual(['Corp.Local', '10.0.0.1', '10.0.0.0/8'])
  })

  it('reports entries the evaluator can never match as invalid, once each', () => {
    const r = parseScopeInput('10.0.0.0/33 999.1.1.1 http://x.com *. host:8080 a$b 10.0.0.0/abc 10.0.0.0/33 fe80::zz')
    expect(r.valid).toEqual([])
    expect(r.invalid).toEqual(['10.0.0.0/33', '999.1.1.1', 'http://x.com', '*.', 'host:8080', 'a$b', '10.0.0.0/abc', 'fe80::zz'])
  })

  it('accepts IPv6 addresses and CIDRs', () => {
    const r = parseScopeInput('2001:db8::/32\nfe80::1\n::1')
    expect(r.valid).toEqual(['2001:db8::/32', 'fe80::1', '::1'])
    expect(r.invalid).toEqual([])
  })

  it('accepts wildcard hosts and they match through the canonical evaluator', () => {
    const r = parseScopeInput('*.corp.local')
    expect(r.valid).toEqual(['*.corp.local'])
    expect(matchPattern('dc01.corp.local', r.valid[0])).toBe(true)
  })

  it('returns nothing for empty input', () => {
    expect(parseScopeInput('  \n , ')).toEqual({ valid: [], invalid: [] })
  })
})
