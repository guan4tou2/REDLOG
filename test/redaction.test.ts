import { describe, it, expect, beforeEach } from 'vitest'
import {
  redact, maskText, shannonEntropy,
  configureRedaction, getRules, DEFAULT_RULES,
  registerRedactionRules, unregisterRedactionRules
} from '../src/core/redaction'

// v0.7.4 F6: unit-test coverage for `src/core/redaction.ts` restored.
// v0.7.2 renamed `test/redaction.test.ts` → `test/secret-redaction.test.ts`
// when adding a *different* module of the same name (secret-pattern regex
// for the agent-transcript-tailer). The rename accidentally left the
// still-live `src/core/redaction.ts` module (four-layer entropy/denylist
// redaction, imported by `main/clipboard-monitor.ts` and
// `main/index.ts`'s `configureRedaction`) with zero test coverage. This
// file re-adds tests for its five public surfaces.

beforeEach(() => {
  // Reset the module-level `activeRules` between tests so leaked state
  // from a prior `configureRedaction` doesn't contaminate the next case.
  configureRedaction(DEFAULT_RULES)
})

describe('shannonEntropy', () => {
  it('returns 0 for empty', () => expect(shannonEntropy('')).toBe(0))
  it('returns 0 for a single-char string', () => expect(shannonEntropy('aaaaa')).toBe(0))
  it('rises with variety', () => {
    const low = shannonEntropy('aaaabbbb')
    const high = shannonEntropy('abcdefgh')
    expect(high).toBeGreaterThan(low)
    expect(high).toBeCloseTo(3, 1)
  })
})

describe('redact — entropy path', () => {
  it('flags a high-entropy token above minLength', () => {
    const { redacted } = redact('token=abcDEF123-XYZ_890qwertyLONG_ENTROPY')
    expect(redacted.length).toBeGreaterThanOrEqual(1)
    expect(redacted[0].pattern).toBe('entropy')
  })
  it('leaves low-entropy strings alone', () => {
    const { redacted } = redact('aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(redacted).toHaveLength(0)
  })
  it('leaves short tokens alone (below minLength)', () => {
    const { redacted } = redact('shortRand789')
    expect(redacted).toHaveLength(0)
  })
})

describe('redact — denylist / allowlist', () => {
  it('flags denylist substring match', () => {
    configureRedaction({ denylist: ['SECRET_MARKER'] })
    const { redacted } = redact('here_is_SECRET_MARKER_inside_a_long_token')
    expect(redacted.some((r) => r.pattern === 'denylist')).toBe(true)
  })
  it('allowlist prevents entropy match', () => {
    // A high-entropy token normally flagged, but allowlisted substring wins.
    configureRedaction({ allowlist: ['LICENSED_KEY_'] })
    const { redacted } = redact('LICENSED_KEY_abcDEF123XYZ890qwertyRANDOM')
    expect(redacted).toHaveLength(0)
  })
  it('denylist regex form: /pattern/ literal', () => {
    configureRedaction({ denylist: ['/^HTB_[A-Z0-9]+$/'] })
    // The tokenizer only surfaces tokens ≥16 chars for the denylist check,
    // so pad the token past that threshold before asserting.
    // `=` is in the tokenizer's char class, so `flag=HTB_...` would extract
    // as a single token `flag=HTB_...` and miss the `^HTB_` anchor. Use
    // whitespace before the token instead.
    const { redacted } = redact('flag  HTB_ABCDEFGHIJK12345 more text')
    expect(redacted.length).toBeGreaterThanOrEqual(1)
  })
  it('malformed denylist regex is silently ignored', () => {
    configureRedaction({ denylist: ['/(unclosed/'] })
    // Should not throw.
    expect(() => redact('any token here abc123DEF456XYZ789LONG_TOKEN')).not.toThrow()
  })
})

describe('maskText', () => {
  it('replaces span with bullet chars of same length', () => {
    const text = 'prefix SECRETTOKEN suffix'
    const spans = [{ pattern: 'denylist' as const, hint: 'x', start: 7, end: 18 }]
    const out = maskText(text, spans)
    expect(out).toBe('prefix ••••••••••• suffix')
    expect(out).toHaveLength(text.length)
  })
  it('no spans → passthrough', () => {
    const text = 'nothing to mask'
    expect(maskText(text, [])).toBe(text)
  })
  it('handles multiple spans in ascending order', () => {
    const text = 'a AAAA b BBBB c'
    const spans = [
      { pattern: 'denylist' as const, hint: '', start: 2, end: 6 },
      { pattern: 'denylist' as const, hint: '', start: 9, end: 13 }
    ]
    expect(maskText(text, spans)).toBe('a •••• b •••• c')
  })
  it('handles unsorted span input', () => {
    const text = 'a AAAA b BBBB c'
    const spans = [
      { pattern: 'denylist' as const, hint: '', start: 9, end: 13 },
      { pattern: 'denylist' as const, hint: '', start: 2, end: 6 }
    ]
    expect(maskText(text, spans)).toBe('a •••• b •••• c')
  })
  it('custom mask char', () => {
    const text = 'hello WORLD'
    const spans = [{ pattern: 'entropy' as const, hint: '', start: 6, end: 11 }]
    expect(maskText(text, spans, '*')).toBe('hello *****')
  })
})

describe('plugin rules registry', () => {
  it('merges denylist entries from all registered plugins', () => {
    registerRedactionRules('plugin-a', { denylist: ['AAA_MARKER'] })
    registerRedactionRules('plugin-b', { denylist: ['BBB_MARKER'] })
    const effective = getRules()
    expect(effective.denylist).toContain('AAA_MARKER')
    expect(effective.denylist).toContain('BBB_MARKER')
    unregisterRedactionRules('plugin-a')
    unregisterRedactionRules('plugin-b')
    expect(getRules().denylist).not.toContain('AAA_MARKER')
    expect(getRules().denylist).not.toContain('BBB_MARKER')
  })
  it('unregister removes only the named plugin', () => {
    registerRedactionRules('p1', { denylist: ['KEEP_X'] })
    registerRedactionRules('p2', { denylist: ['DROP_X'] })
    unregisterRedactionRules('p2')
    const eff = getRules()
    expect(eff.denylist).toContain('KEEP_X')
    expect(eff.denylist).not.toContain('DROP_X')
    unregisterRedactionRules('p1')
  })
})
