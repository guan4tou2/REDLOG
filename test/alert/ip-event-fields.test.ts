import { describe, it, expect } from 'vitest'
import { ipEventFields } from '../../src/core/alert/surface'
import type { IPVerdict } from '../../src/core/alert'

// v0.13.0 fix: earlier revisions wrote `ip_verdict_kind: v.kind` — but on
// a `Verdict` union `.kind` is the outer discriminator (always `'ip'` for
// IP verdicts), NOT the classified value. The right field is `v.value`.
// The bug was silent: every ip_verdict event landed with the same literal
// `'ip'` string, defeating downstream filters and v0.13's tier classifier
// (`classifyTier` routes on `ip_verdict_kind === 'unchanged'`).
//
// This test locks the emitted-event shape so the two names can never
// silently swap again.

function verdict(over: Partial<IPVerdict>): IPVerdict & { kind: 'ip' } {
  return {
    kind: 'ip',
    value: 'safe',
    authority: 'fact',
    severity: 'clean',
    ...over
  }
}

describe('ipEventFields — emitted event shape', () => {
  it('ip_verdict_kind carries the classified value, not the union discriminator', () => {
    for (const val of ['safe', 'presumed_safe', 'off_profile', 'exposed', 'unknown'] as const) {
      const out = ipEventFields(verdict({ value: val }))
      expect(out.ip_verdict_kind).toBe(val)
    }
  })

  it('modifiers only appear when true (not present when false/absent)', () => {
    const out = ipEventFields(verdict({ value: 'safe' }))
    expect(out.settling).toBeUndefined()
    expect(out.stale).toBeUndefined()
    expect(out.list_conflict).toBeUndefined()
    expect(out.lan_safety).toBeUndefined()
  })

  it('modifiers surface when set', () => {
    const out = ipEventFields(verdict({
      value: 'exposed',
      settling: true,
      stale: true,
      listConflict: true,
      lanSafety: 'safe'
    }))
    expect(out.ip_verdict_kind).toBe('exposed')
    expect(out.settling).toBe(true)
    expect(out.stale).toBe(true)
    expect(out.list_conflict).toBe(true)
    expect(out.lan_safety).toBe('safe')
  })
})
