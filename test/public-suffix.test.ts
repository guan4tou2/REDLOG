import { describe, it, expect } from 'vitest'
import { getRegistrableDomain, buildSuffixSet, DEFAULT_SUFFIXES } from '../src/core/public-suffix'

describe('getRegistrableDomain', () => {
  const cases: Array<[string, string]> = [
    // Ordinary TLDs — the last-two-labels fallback is already correct here.
    ['example.com', 'example.com'],
    ['api.example.com', 'example.com'],
    ['a.b.c.example.com', 'example.com'],
    ['example.io', 'example.io'],
    ['localhost', 'localhost'],

    // The reported defect: multi-label ccTLD suffixes.
    ['shop.example.co.uk', 'example.co.uk'],
    ['example.co.uk', 'example.co.uk'],
    ['deep.sub.corp.com.tw', 'corp.com.tw'],
    ['www.tokyo.co.jp', 'tokyo.co.jp'],
    ['a.b.gov.au', 'b.gov.au'],

    // Platform suffixes — the half that bites hardest in bug-bounty scopes.
    ['target.github.io', 'target.github.io'],
    ['docs.target.github.io', 'target.github.io'],
    ['mybucket.s3.amazonaws.com', 'mybucket.s3.amazonaws.com'],
    ['app.azurewebsites.net', 'app.azurewebsites.net'],
    ['thing.herokuapp.com', 'thing.herokuapp.com'],

    // Degenerate: the host IS the suffix. Nothing shorter to return.
    ['co.uk', 'co.uk'],
    ['github.io', 'github.io'],

    ['API.Example.CO.UK', 'example.co.uk']
  ]

  for (const [host, expected] of cases) {
    it(`${host} → ${expected}`, () => {
      expect(getRegistrableDomain(host)).toBe(expected)
    })
  }

  // The safety property the curated table rests on (see public-suffix.ts):
  // a suffix the table has never heard of must degrade to the OLD behaviour
  // (over-match → noise), never to a longer domain (under-match → silence).
  it('an unknown suffix falls back to the last two labels — noisy, never silent', () => {
    expect(getRegistrableDomain('shop.example.unknown-suffix.zz')).toBe('unknown-suffix.zz')
  })

  it('the longest matching suffix wins', () => {
    const set = buildSuffixSet(['example.co.uk'])
    expect(getRegistrableDomain('a.b.example.co.uk', set)).toBe('b.example.co.uk')
  })
})

describe('buildSuffixSet', () => {
  it('is additive — built-ins survive an operator list', () => {
    const set = buildSuffixSet(['weird.internal'])
    expect(set.has('co.uk')).toBe(true)
    expect(set.has('weird.internal')).toBe(true)
  })

  it('normalises leading wildcards, dots and case', () => {
    const set = buildSuffixSet(['*.Corp.Internal', '.trailing.zz.'])
    expect(set.has('corp.internal')).toBe(true)
    expect(set.has('trailing.zz')).toBe(true)
  })

  it('ignores single-label entries — the fallback already covers bare TLDs', () => {
    const before = DEFAULT_SUFFIXES.size
    expect(buildSuffixSet(['com', '', '  ']).size).toBe(before)
  })

  it('an operator entry takes effect end to end', () => {
    expect(getRegistrableDomain('a.b.corp.internal')).toBe('corp.internal')
    expect(getRegistrableDomain('a.b.corp.internal', buildSuffixSet(['corp.internal']))).toBe('b.corp.internal')
  })
})
