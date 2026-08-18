import { describe, it, expect, beforeEach } from 'vitest'
import {
  redact,
  configureRedaction,
  registerRedactionRules,
  unregisterRedactionRules,
  DEFAULT_RULES,
  getRules
} from '../src/core/redaction'

// v0.12.1: redaction.ts caches precompiled patterns + merged effective rules
// so a shell command_end with 20 denylist regex × 100 tokens doesn't rebuild
// 2000 RegExp per event. These tests lock the contract: cache invalidates on
// configure / register / unregister; regex patterns still fire correctly;
// callers that hand in a NEW rules object (api-server merges lootValues per
// event) compile those local lists once, not per token.

describe('redaction cache (v0.12.1)', () => {
  beforeEach(() => {
    // Reset to defaults + drop any plugin rules from a prior test.
    configureRedaction({ ...DEFAULT_RULES })
    unregisterRedactionRules('test-plugin')
  })

  it('literal denylist entry masks a matching token', () => {
    configureRedaction({ denylist: ['SECRET_TOKEN_ABC123'] })
    const r = redact('leak: SECRET_TOKEN_ABC123XYZ found')
    expect(r.redacted).toHaveLength(1)
    expect(r.redacted[0].pattern).toBe('denylist')
  })

  it('regex denylist entry masks a matching token', () => {
    configureRedaction({ denylist: ['/^ghp_[A-Za-z0-9]+$/'] })
    // Space-separated so TOKEN_RE (which greedily matches `[A-Za-z0-9_\-\.\/+=]`)
    // grabs the bare `ghp_…` — otherwise it'd swallow `token=ghp_…` as one match
    // and the /^ghp_/ regex wouldn't fire.
    const r = redact('leaked ghp_abcdefghijklmnop12345 today')
    expect(r.redacted).toHaveLength(1)
    expect(r.redacted[0].pattern).toBe('denylist')
  })

  it('allowlist wins over entropy detection', () => {
    configureRedaction({
      allowlist: ['/^ALWAYS_OK_/'],
      denylist: [],
      entropyThreshold: 3.0,  // low so a plain token would normally hit
      minLength: 10
    })
    // High-entropy token that would hit the entropy branch — allowlist skips.
    const r = redact('note: ALWAYS_OK_abcdEFGH1234!@#$ passed')
    // The token starts with `ALWAYS_OK_` prefix → matches the allowlist regex.
    expect(r.redacted.every((s) => !s.hint.startsWith('16 chars'))).toBe(true)
  })

  it('configureRedaction invalidates the cache — next redact sees new rules', () => {
    configureRedaction({ denylist: [] })
    const before = redact('foo=SECRET_BAR12345 baz')
    expect(before.redacted).toHaveLength(0)
    configureRedaction({ denylist: ['SECRET_BAR'] })
    const after = redact('foo=SECRET_BAR12345 baz')
    expect(after.redacted).toHaveLength(1)
  })

  it('registerRedactionRules merges into effective rules on next redact', () => {
    configureRedaction({ denylist: [] })
    expect(redact('key=PLUGIN_SECRET_1234').redacted).toHaveLength(0)
    registerRedactionRules('test-plugin', { denylist: ['PLUGIN_SECRET'] })
    expect(redact('key=PLUGIN_SECRET_1234').redacted).toHaveLength(1)
    unregisterRedactionRules('test-plugin')
    expect(redact('key=PLUGIN_SECRET_1234').redacted).toHaveLength(0)
  })

  it('per-call rules object compiles independently of cached rules', () => {
    // TOKEN_RE only matches ≥16-char runs of [A-Za-z0-9_\-\.\/+=], so the
    // test strings need to be that long to be scanned at all.
    configureRedaction({ denylist: ['GLOBAL_MATCH_STRING'] })
    const perCall = {
      ...getRules(),
      denylist: [...getRules().denylist, 'LOCAL_MERGE_STRING']
    }
    const r = redact('LOCAL_MERGE_STRING_ABC GLOBAL_MATCH_STRING_XYZ', perCall)
    const hints = r.redacted.map((x) => x.pattern)
    expect(hints.filter((h) => h === 'denylist').length).toBe(2)
  })

  it('cache survives many redact calls without recompiling patterns', () => {
    // Not a timing test — just a smoke check that repeated calls with the
    // same rules don't error. If precompilation regressed to per-call, this
    // still passes; the value is in preventing crashes from stateful regex
    // /g flags accidentally leaking (see the TOKEN_RE clone note).
    configureRedaction({ denylist: ['/^tok_[a-z0-9]+$/'] })
    for (let i = 0; i < 100; i++) {
      const r = redact(`iter${i} tok_${i.toString(16).padStart(8, '0')}abcd`)
      expect(r.redacted).toHaveLength(1)
    }
  })
})
