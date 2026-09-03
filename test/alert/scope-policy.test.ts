import { describe, it, expect, beforeEach } from 'vitest'
import { ScopePolicy, classifyScopeTarget, isReportable, alertFloorFor } from '../../src/core/alert/policies'
import { matchTarget } from '../../src/core/db/events'
import type { TargetHitSignal } from '../../src/core/alert/signal'

function hit(target: string): TargetHitSignal {
  return {
    kind: 'target_hit',
    timestamp: 1_700_000_000_000,
    target,
    source: 'shell',
    sourceEventId: null,
    action: `curl ${target}`
  }
}

describe('ScopePolicy — D1-D4 distance ladder', () => {
  let p: ScopePolicy
  beforeEach(() => { p = new ScopePolicy() })

  it('D1 excluded: explicit deny dominates', () => {
    p.configure({ targets: ['*.example.com'], excludeTargets: ['admin.example.com'] })
    const [v] = p.evaluate(hit('admin.example.com'))
    expect(v).toMatchObject({ distance: 'excluded', authority: 'fact', severity: 'critical' })
  })

  it('D4 in_scope: explicit include', () => {
    p.configure({ targets: ['*.example.com'] })
    const [v] = p.evaluate(hit('www.example.com'))
    expect(v).toMatchObject({ distance: 'in_scope', authority: 'fact', severity: 'clean' })
  })

  it('D2 adjacent_subnet: same /24 as CIDR target', () => {
    p.configure({ targets: ['10.0.0.0/24'] })
    const [v] = p.evaluate(hit('10.0.0.99'))
    // 10.0.0.99 is IN scope (matches CIDR), so it should be in_scope, not adjacent
    expect(v.distance).toBe('in_scope')

    p.configure({ targets: ['10.0.0.5'] })  // single host only
    const [v2] = p.evaluate(hit('10.0.0.99'))
    expect(v2).toMatchObject({ distance: 'adjacent_subnet', authority: 'inferred', severity: 'warning' })
  })

  it('D3 adjacent_domain: same registrable domain, different subdomain', () => {
    p.configure({ targets: ['app.example.com'] })
    const [v] = p.evaluate(hit('admin.example.com'))
    expect(v).toMatchObject({ distance: 'adjacent_domain', authority: 'inferred', severity: 'warning' })
  })

  it('D3 registrable-domain fix: co.uk is not the registrable domain', () => {
    p.configure({ targets: ['target.co.uk'], alertFloor: ['unrelated', 'adjacent_domain'] })
    // "attacker.co.uk" shares only the eTLD; must NOT be adjacent.
    const [v] = p.evaluate(hit('attacker.co.uk'))
    expect(v?.distance).toBe('unrelated')
    // But a subdomain of target IS adjacent.
    const [v2] = p.evaluate(hit('admin.target.co.uk'))
    expect(v2?.distance).toBe('adjacent_domain')
  })

  it('unrelated: completely different domain fires at floor', () => {
    p.configure({ targets: ['*.example.com'], alertFloor: ['excluded', 'adjacent_subnet', 'adjacent_domain', 'unrelated'] })
    const [v] = p.evaluate(hit('google.com'))
    expect(v).toMatchObject({ distance: 'unrelated', authority: 'inferred' })
  })

  it('unrelated: default alertFloor suppresses the emit', () => {
    p.configure({ targets: ['*.example.com'] })  // default floor excludes unrelated
    const r = p.evaluate(hit('google.com'))
    expect(r).toHaveLength(0)
  })

  it('in_scope always emits (adherence counter needs the positive proof)', () => {
    p.configure({ targets: ['*.example.com'], alertFloor: [] })  // even with empty floor
    const r = p.evaluate(hit('www.example.com'))
    expect(r).toHaveLength(1)
    expect(r[0].distance).toBe('in_scope')
  })

  it('no config → everything in_scope by default', () => {
    p.configure({})
    const [v] = p.evaluate(hit('anything.com'))
    expect(v).toMatchObject({ distance: 'in_scope', authority: 'unknown' })
  })

  it('CIDR wildcard /0 matches everything', () => {
    p.configure({ targets: ['0.0.0.0/0'] })
    const [v] = p.evaluate(hit('8.8.8.8'))
    expect(v.distance).toBe('in_scope')
  })

  it('IPv6 exact match works (prefix arithmetic falls back to exact)', () => {
    p.configure({ targets: ['2001:db8::1'] })
    const [v] = p.evaluate(hit('2001:db8::1'))
    expect(v.distance).toBe('in_scope')
  })

  it('IPv6 non-match degrades to unrelated, not adjacent', () => {
    p.configure({ targets: ['2001:db8::1'], alertFloor: ['unrelated'] })
    const [v] = p.evaluate(hit('2001:db8::2'))
    expect(v.distance).toBe('unrelated')
  })

  it('exclude wildcard: *.staging.example.com', () => {
    p.configure({ targets: ['*.example.com'], excludeTargets: ['*.staging.example.com'] })
    const [v] = p.evaluate(hit('api.staging.example.com'))
    expect(v.distance).toBe('excluded')
  })
})

describe('the pure classifier is the same classifier', () => {
  // The recompute re-judges rows the live path already judged. If the two
  // answers can differ, an allowlist change produces verdicts that contradict
  // the ones already in the chain, and there is no way to tell which is right.
  const CASES: Array<{ targets: string[]; excludes?: string[]; target: string }> = [
    { targets: ['*.example.com'], excludes: ['admin.example.com'], target: 'admin.example.com' },
    { targets: ['*.example.com'], target: 'www.example.com' },
    { targets: ['10.0.0.5'], target: '10.0.0.99' },
    { targets: ['10.0.0.0/24'], target: '10.0.0.99' },
    { targets: ['example.com'], target: 'other.example.com' },
    { targets: ['*.example.com'], target: 'evil.test' },
    { targets: [], target: 'anything.at.all' }
  ]

  it('agrees with ScopePolicy.evaluate on every ladder case', () => {
    for (const c of CASES) {
      const p = new ScopePolicy()
      p.configure({ targets: c.targets, excludeTargets: c.excludes ?? [], alertFloor: alertFloorFor(true) })
      const pure = classifyScopeTarget(c.target, { targets: c.targets, excludeTargets: c.excludes ?? [] })
      const [v] = p.evaluate({
        kind: 'target_hit', timestamp: 0, target: c.target,
        source: 'shell', sourceEventId: null, action: 'x'
      })
      if (v) {
        expect(pure.distance, `${c.target} vs ${JSON.stringify(c.targets)}`).toBe(v.distance)
        expect(pure.authority).toBe(v.authority)
        expect(pure.severity).toBe(v.severity)
      } else {
        // No verdict emitted means the distance was below the floor — which is
        // exactly what isReportable says about the pure answer.
        expect(isReportable(pure.distance, alertFloorFor(true))).toBe(false)
      }
    }
  })

  it('reproduces the emit gate under every floor the app actually uses', () => {
    expect(alertFloorFor(false)).toEqual(['excluded'])
    expect(alertFloorFor(true)).toEqual(['excluded', 'adjacent_subnet', 'adjacent_domain'])
    expect(alertFloorFor(undefined)).toEqual(alertFloorFor(true))
    // `unrelated` is in neither floor: off-profile traffic is noticed, not
    // alarmed about. A recompute that ignored this would "newly flag" the
    // entire unrelated corpus on the first save.
    expect(isReportable('unrelated', alertFloorFor(true))).toBe(false)
    expect(isReportable('in_scope', alertFloorFor(true))).toBe(false)
    expect(isReportable('adjacent_domain', alertFloorFor(false))).toBe(false)
    expect(isReportable('excluded', alertFloorFor(false))).toBe(true)
  })

  it('classifies case-sensitively, so a caller must not normalise first', () => {
    const scope = { targets: ['*.Example.com'], excludeTargets: [] }
    expect(classifyScopeTarget('www.Example.com', scope).distance).toBe('in_scope')
    expect(classifyScopeTarget('www.example.com', scope).distance).not.toBe('in_scope')
  })

  it('does NOT agree with matchTarget — the two matchers are different questions', () => {
    // Documented rather than fixed. `matchTarget` (used by retention's body
    // pinning) is a substring test, so the pattern 'evil' pins anything
    // containing it; the policy matcher is exact-or-wildcard. A recompute must
    // use the policy matcher, because parity with the live verdict is the
    // whole point. Unifying them is a separate, deliberate change. They also
    // disagree on case: matchTarget lowercases both sides, the policy does not.
    expect(matchTarget('a.evil.example', 'evil')).toBe(true)
    expect(classifyScopeTarget('a.evil.example', { targets: ['evil'], excludeTargets: [] }).distance)
      .not.toBe('in_scope')
  })
})
