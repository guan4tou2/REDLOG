import { describe, it, expect } from 'vitest'
import { redact, shannonEntropy, DEFAULT_RULES } from '../src/core/redaction'

describe('redaction', () => {
  it('leaves ordinary text alone', () => {
    const r = redact('hello world this is a normal sentence')
    expect(r.text).toBe('hello world this is a normal sentence')
    expect(r.redacted.length).toBe(0)
  })

  it('redacts high-entropy tokens', () => {
    const secret = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const r = redact(`token: ${secret} rest of the log`, {
      ...DEFAULT_RULES, entropyThreshold: 3.5
    })
    expect(r.text).toContain('[REDACTED_ENTROPY_')
    expect(r.text).not.toContain(secret)
    expect(r.redacted.length).toBe(1)
    expect(r.redacted[0].pattern).toBe('entropy')
  })

  it('leaves short/low-entropy strings alone even if long', () => {
    const r = redact('aaaaaaaaaaaaaaaaaaaaaa') // long but zero entropy
    expect(r.text).toBe('aaaaaaaaaaaaaaaaaaaaaa')
  })

  it('allowlist blocks entropy match', () => {
    const secret = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const r = redact(secret, { ...DEFAULT_RULES, allowlist: [secret] })
    expect(r.text).toBe(secret)
    expect(r.redacted.length).toBe(0)
  })

  it('denylist redacts even low-entropy tokens', () => {
    const r = redact('marker: internal-project-alpha-x', {
      ...DEFAULT_RULES, denylist: ['internal-project-alpha']
    })
    expect(r.text).toContain('[REDACTED_DENY]')
  })

  it('denylist supports /regex/ syntax', () => {
    const r = redact('leak: ABCDEF1234567890abcdef', {
      ...DEFAULT_RULES, denylist: ['/^ABCDEF/']
    })
    expect(r.text).toContain('[REDACTED_DENY]')
  })

  it('shannonEntropy sanity', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaa')).toBe(0)
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5)
    expect(shannonEntropy('abcdefgh')).toBeCloseTo(3, 5)
  })
})
