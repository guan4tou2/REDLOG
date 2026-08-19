import { describe, it, expect, beforeEach } from 'vitest'
import { IPPolicy } from '../../src/core/alert/policies'
import type { IPChangeSignal } from '../../src/core/alert/signal'

function ipChange(external: string | null, extra: Partial<IPChangeSignal> = {}): IPChangeSignal {
  return {
    kind: 'ip_change',
    timestamp: 1_700_000_000_000,
    external,
    internal: null,
    settling: false,
    stale: false,
    ...extra
  }
}

describe('IPPolicy — five-verdict matrix', () => {
  let p: IPPolicy
  beforeEach(() => { p = new IPPolicy() })

  it('safe: whitelist hit → fact + clean', () => {
    p.configure({ safeIps: ['10.8.0.0/16'], exposedIps: [] })
    const [v] = p.evaluate(ipChange('10.8.1.5'))
    expect(v).toMatchObject({ kind: 'ip', value: 'safe', authority: 'fact', severity: 'clean' })
  })

  it('exposed: blacklist hit → fact + critical (dominates safe)', () => {
    p.configure({ safeIps: ['1.1.1.1'], exposedIps: ['1.1.1.1'] })
    const [v] = p.evaluate(ipChange('1.1.1.1'))
    expect(v).toMatchObject({ value: 'exposed', authority: 'fact', severity: 'critical', listConflict: true })
  })

  it('off_profile: safe list configured, IP not on it (no exposed) → fact + warning', () => {
    p.configure({ safeIps: ['10.8.0.0/16'] })
    const [v] = p.evaluate(ipChange('203.0.113.5'))
    expect(v).toMatchObject({ value: 'off_profile', authority: 'fact', severity: 'warning' })
  })

  it('presumed_safe: no safe list, exposed configured, IP not on it → inferred + notice', () => {
    p.configure({ exposedIps: ['203.0.113.99'] })
    const [v] = p.evaluate(ipChange('198.51.100.1'))
    expect(v).toMatchObject({ value: 'presumed_safe', authority: 'inferred', severity: 'notice' })
  })

  it('unknown: no lists configured → unknown + notice', () => {
    p.configure({})
    const [v] = p.evaluate(ipChange('203.0.113.5'))
    expect(v).toMatchObject({ value: 'unknown', authority: 'unknown' })
  })

  it('unknown: stale signal never collapses to safe', () => {
    p.configure({ safeIps: ['10.0.0.0/8'] })
    const [v] = p.evaluate(ipChange('10.0.0.1', { stale: true }))
    expect(v.value).toBe('unknown')
    expect(v.stale).toBe(true)
  })

  it('settling modifier is independent of base verdict', () => {
    p.configure({ safeIps: ['10.0.0.0/8'] })
    const [v] = p.evaluate(ipChange('10.0.0.1', { settling: true }))
    expect(v.value).toBe('safe')
    expect(v.settling).toBe(true)
  })

  it('dedup: same value repeated does not re-emit', () => {
    p.configure({ safeIps: ['10.0.0.0/8'] })
    expect(p.evaluate(ipChange('10.0.0.1'))).toHaveLength(1)
    expect(p.evaluate(ipChange('10.0.0.2'))).toHaveLength(0)  // still safe
  })

  it('dedup: verdict change re-emits', () => {
    p.configure({ safeIps: ['10.0.0.0/8'], exposedIps: ['1.1.1.1'] })
    expect(p.evaluate(ipChange('10.0.0.1'))[0].value).toBe('safe')
    expect(p.evaluate(ipChange('1.1.1.1'))[0].value).toBe('exposed')
  })

  it('configure() invalidates dedup so config edits re-emit', () => {
    p.configure({ safeIps: ['10.0.0.0/8'] })
    expect(p.evaluate(ipChange('10.0.0.1'))).toHaveLength(1)
    p.configure({ safeIps: ['192.168.0.0/16'] })
    expect(p.evaluate(ipChange('10.0.0.1'))).toHaveLength(1)  // now off_profile
  })

  it('ignores non-ip_change signals', () => {
    p.configure({ safeIps: ['10.0.0.0/8'] })
    const r = p.evaluate({
      kind: 'target_hit', timestamp: 0, target: 'x', source: 'shell', sourceEventId: null, action: ''
    })
    expect(r).toHaveLength(0)
  })
})
