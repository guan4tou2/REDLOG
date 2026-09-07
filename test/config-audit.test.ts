import { describe, it, expect } from 'vitest'
import { diffSecurityConfig, describeOpsecDelta } from '../src/main/config-audit'
import type { RedLogConfig } from '../src/core/config'

// Extracted from main/index.ts (decomposition) — never testable there because
// that module imports electron. config-audit imports only types, so it runs
// under vitest.

const cfg = (over: Record<string, unknown> = {}): RedLogConfig => ({
  engagement: { id: 'e1', name: 'E' },
  operator: { id: 'op1', name: 'Op' },
  scope: { warnOnViolation: true, targets: ['10.0.0.0/24'], excludeTargets: [], scopeFile: '' },
  network: { whitelist: [], blacklist: [], checkInterval: 60 },
  ...over
} as unknown as RedLogConfig)

describe('diffSecurityConfig', () => {
  it('is empty when nothing security-relevant changed', () => {
    expect(diffSecurityConfig(cfg(), cfg())).toEqual({})
  })

  it('value-compares scope target lists (array by content, not identity)', () => {
    const a = cfg()
    const b = cfg({ scope: { warnOnViolation: true, targets: ['10.0.0.0/24', '10.0.1.0/24'], excludeTargets: [], scopeFile: '' } })
    const d = diffSecurityConfig(a, b)
    expect(d['scope.targets']).toEqual({ from: ['10.0.0.0/24'], to: ['10.0.0.0/24', '10.0.1.0/24'] })
    // An unrelated field with the same content does NOT show up.
    expect(d['operator.id']).toBeUndefined()
  })

  it('flags loosening scope enforcement and operator identity', () => {
    const d = diffSecurityConfig(
      cfg(),
      cfg({ scope: { warnOnViolation: false, targets: ['10.0.0.0/24'], excludeTargets: [], scopeFile: '' }, operator: { id: 'op2', name: 'Op2' } })
    )
    expect(d['scope.warnOnViolation']).toEqual({ from: true, to: false })
    expect(d['operator.id']).toEqual({ from: 'op1', to: 'op2' })
    expect(d['operator.name']).toEqual({ from: 'Op', to: 'Op2' })
  })

  it('ignores cosmetic changes (only the audited fields are compared)', () => {
    // A field not in the audited set (e.g. overlay opacity) must not appear.
    const d = diffSecurityConfig(cfg({ overlay: { scale: 1 } }), cfg({ overlay: { scale: 2 } }))
    expect(d).toEqual({})
  })
})

describe('describeOpsecDelta', () => {
  it('summarises VPN up/down, MAC, DNS and hostname', () => {
    expect(describeOpsecDelta({ vpn: { from: [], to: ['tun0'] } })).toBe('VPN up: tun0')
    expect(describeOpsecDelta({ vpn: { from: ['tun0'], to: [] } })).toBe('VPN down: tun0')
    expect(describeOpsecDelta({ primaryMac: { from: 'aa', to: 'bb' } })).toBe('MAC aa → bb')
    expect(describeOpsecDelta({ dns: { from: ['1.1.1.1'], to: ['8.8.8.8'] } })).toBe('DNS 1.1.1.1 → 8.8.8.8')
    expect(describeOpsecDelta({ hostname: { from: 'a', to: 'b' } })).toBe('hostname a → b')
  })

  it('falls back to a generic line when the delta has no recognised change', () => {
    expect(describeOpsecDelta({})).toBe('OPSEC state changed')
    // A DNS delta with identical sets contributes nothing.
    expect(describeOpsecDelta({ dns: { from: ['1.1.1.1'], to: ['1.1.1.1'] } })).toBe('OPSEC state changed')
  })
})
