import { describe, it, expect, afterEach } from 'vitest'
import {
  redact, maskText, shannonEntropy, DEFAULT_RULES,
  registerRedactionRules, unregisterRedactionRules, getRules
} from '../src/core/redaction'

describe('redaction — layer 1 (capture) + layer 2 (detect)', () => {
  it('leaves ordinary text alone; no spans', () => {
    const r = redact('hello world this is a normal sentence')
    expect(r.text).toBe('hello world this is a normal sentence')
    expect(r.redacted.length).toBe(0)
  })

  it('detects high-entropy tokens without mutating the text', () => {
    const secret = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const input = `token: ${secret} rest of the log`
    const r = redact(input, { ...DEFAULT_RULES, entropyThreshold: 3.5 })
    // Layer 1 promise: source bytes are preserved verbatim.
    expect(r.text).toBe(input)
    expect(r.text).toContain(secret)
    // Layer 2: span metadata identifies the sensitive region.
    expect(r.redacted.length).toBe(1)
    expect(r.redacted[0].pattern).toBe('entropy')
    expect(r.redacted[0].start).toBe(input.indexOf(secret))
    expect(r.redacted[0].end).toBe(input.indexOf(secret) + secret.length)
  })

  it('leaves short/low-entropy strings alone even if long', () => {
    const r = redact('aaaaaaaaaaaaaaaaaaaaaa') // long but zero entropy
    expect(r.text).toBe('aaaaaaaaaaaaaaaaaaaaaa')
    expect(r.redacted.length).toBe(0)
  })

  it('allowlist blocks entropy match (no span emitted)', () => {
    const secret = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const r = redact(secret, { ...DEFAULT_RULES, allowlist: [secret] })
    expect(r.text).toBe(secret)
    expect(r.redacted.length).toBe(0)
  })

  it('denylist emits a span even for low-entropy tokens (text stays raw)', () => {
    const input = 'marker: internal-project-alpha-x'
    const r = redact(input, { ...DEFAULT_RULES, denylist: ['internal-project-alpha'] })
    expect(r.text).toBe(input) // raw preserved
    expect(r.redacted.length).toBe(1)
    expect(r.redacted[0].pattern).toBe('denylist')
  })

  it('denylist supports /regex/ syntax', () => {
    const input = 'leak: ABCDEF1234567890abcdef'
    const r = redact(input, { ...DEFAULT_RULES, denylist: ['/^ABCDEF/'] })
    expect(r.text).toBe(input)
    expect(r.redacted.length).toBe(1)
    expect(r.redacted[0].pattern).toBe('denylist')
  })

  it('concurrent calls do not leak lastIndex state', () => {
    // Two calls interleaved via nested loop; both must find their own matches.
    const rules = { ...DEFAULT_RULES, entropyThreshold: 3.5 }
    const s1 = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const s2 = 'sk-test-abcdef0123456789abcdef0123456789abcdef01'
    for (let i = 0; i < 5; i++) {
      expect(redact(`a ${s1} b`, rules).redacted.length).toBe(1)
      expect(redact(`a ${s2} b`, rules).redacted.length).toBe(1)
    }
  })
})

describe('maskText', () => {
  it('replaces spans with bullet chars sized to the span', () => {
    const text = 'aa SECRET bb'
    const spans = [{ pattern: 'denylist' as const, hint: '', start: 3, end: 9 }]
    expect(maskText(text, spans)).toBe('aa •••••• bb')
  })

  it('handles multiple non-overlapping spans in order', () => {
    const text = 'X yyyy Z wwww Q'
    const spans = [
      { pattern: 'denylist' as const, hint: '', start: 2, end: 6 },
      { pattern: 'entropy' as const, hint: '', start: 9, end: 13 }
    ]
    expect(maskText(text, spans)).toBe('X •••• Z •••• Q')
  })

  it('sorts unordered spans before masking', () => {
    const text = 'X yyyy Z wwww Q'
    const spans = [
      { pattern: 'entropy' as const, hint: '', start: 9, end: 13 },
      { pattern: 'denylist' as const, hint: '', start: 2, end: 6 }
    ]
    expect(maskText(text, spans)).toBe('X •••• Z •••• Q')
  })

  it('empty spans array returns text unchanged', () => {
    expect(maskText('unchanged', [])).toBe('unchanged')
  })

  it('custom mask char', () => {
    const text = 'aa SECRET bb'
    const spans = [{ pattern: 'denylist' as const, hint: '', start: 3, end: 9 }]
    expect(maskText(text, spans, '*')).toBe('aa ****** bb')
  })
})

describe('shannonEntropy', () => {
  it('sanity', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaa')).toBe(0)
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5)
    expect(shannonEntropy('abcdefgh')).toBeCloseTo(3, 5)
  })
})

describe('redaction edge cases', () => {
  it('redact("") returns empty result without walking the regex', () => {
    const r = redact('')
    expect(r.text).toBe('')
    expect(r.redacted).toEqual([])
  })

  it('empty-string entries in denylist/allowlist are ignored (not "matches everything")', () => {
    // Bug shape if we ever regress: empty '' in denylist would match every token
    // (String#includes('') is always true).
    const secret = 'sk-live-9f8a2d1b0e4c6a7f8b3d5e2c1a0b9d8e7f6a5b4c3d2e1f0'
    const r = redact(`hello ${secret} world`, {
      ...DEFAULT_RULES,
      entropyThreshold: 10, // way above possible, so entropy alone won't match
      denylist: ['']
    })
    expect(r.redacted).toEqual([])
  })

  it('unicode-heavy text with a boring high-entropy token still gets the token flagged', () => {
    const secret = 'abcdefghij0123456789xxxxx'
    const input = `日本語プレフィックス ${secret} 中文后缀 🚀🔥`
    const r = redact(input, { ...DEFAULT_RULES, entropyThreshold: 3.5, minLength: 16 })
    expect(r.redacted.length).toBe(1)
    // Offsets are code-unit indexes into the original string — the raw text
    // slice must reproduce the secret exactly.
    const s = r.redacted[0]
    expect(input.slice(s.start, s.end)).toBe(secret)
  })

  it('malformed /regex/ denylist entry is skipped, siblings still fire', () => {
    // Token must be at least TOKEN_RE.length (16) to be considered by redact().
    const input = 'hello ABCDEF1234567890abcd tail'
    const r = redact(input, {
      ...DEFAULT_RULES,
      denylist: ['/([broken/', '/^ABCDEF/']
    })
    expect(r.redacted.some((x) => x.pattern === 'denylist')).toBe(true)
  })
})

describe('maskText edge cases', () => {
  it('spans that cover the whole string turn everything into bullets', () => {
    const text = 'SECRET'
    const spans = [{ pattern: 'denylist' as const, hint: '', start: 0, end: text.length }]
    expect(maskText(text, spans)).toBe('••••••')
  })

  it('adjacent (touching) spans are both applied', () => {
    const text = 'AAAABBBB'
    const spans = [
      { pattern: 'denylist' as const, hint: '', start: 0, end: 4 },
      { pattern: 'denylist' as const, hint: '', start: 4, end: 8 }
    ]
    expect(maskText(text, spans)).toBe('••••••••')
  })

  it('overlapping spans skip the second (defensive)', () => {
    const text = 'ABCDEFGHIJ'
    const spans = [
      { pattern: 'denylist' as const, hint: '', start: 2, end: 6 },
      { pattern: 'denylist' as const, hint: '', start: 4, end: 8 }
    ]
    // First span masks 2..6; second starts at 4 which is < cursor(6) → skipped.
    expect(maskText(text, spans)).toBe('AB••••GHIJ')
  })

  it('zero-length span still produces at least one mask char (Math.max(1, ...))', () => {
    const text = 'abc'
    const spans = [{ pattern: 'entropy' as const, hint: '', start: 1, end: 1 }]
    // Documented behavior: mask.repeat(Math.max(1, end-start)) = 1 bullet.
    expect(maskText(text, spans)).toBe('a•bc')
  })
})

describe('plugin-contributed redaction rules', () => {
  afterEach(() => {
    unregisterRedactionRules('rt-1')
    unregisterRedactionRules('rt-2')
  })

  it('registered plugin rules are visible via getRules() and merged deduped', () => {
    registerRedactionRules('rt-1', { denylist: ['A', 'B'], allowlist: ['x'] })
    registerRedactionRules('rt-2', { denylist: ['B', 'C'] })
    const rules = getRules()
    // deduped B; allowlist merged too
    expect([...rules.denylist].sort()).toEqual(['A', 'B', 'C'])
    expect(rules.allowlist).toContain('x')
  })

  it('re-registering same plugin id REPLACES its prior contribution', () => {
    registerRedactionRules('rt-1', { denylist: ['OLD-MARK'] })
    registerRedactionRules('rt-1', { denylist: ['NEW-MARK'] })
    const rules = getRules()
    expect(rules.denylist).not.toContain('OLD-MARK')
    expect(rules.denylist).toContain('NEW-MARK')
  })

  it('unregister for an unknown plugin id is a no-op', () => {
    expect(() => unregisterRedactionRules('never-existed')).not.toThrow()
  })
})
