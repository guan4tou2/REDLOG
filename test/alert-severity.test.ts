// The one severity scale (G-C1). Both alarm roles map onto it, so a change here
// changes how BOTH shout — which is the point: they used to drift apart.

import { describe, it, expect } from 'vitest'
import {
  ipSeverity, scopeSeverity, worstSeverity, SEVERITY_CLASS, SEVERITY_HUD, type Severity
} from '../src/renderer/src/lib/alertSeverity'
import { HUD } from '../src/renderer/src/lib/hud'

describe('ipSeverity — Self alarm onto the scale', () => {
  const cases: Array<[string, Severity]> = [
    ['exposed', 'critical'],
    ['off_profile', 'warn'],
    ['unknown', 'unknown'],
    ['safe', 'ok'],
    ['presumed_safe', 'ok']
  ]
  for (const [verdict, expected] of cases) {
    it(`${verdict} → ${expected}`, () => {
      expect(ipSeverity(verdict as Parameters<typeof ipSeverity>[0])).toBe(expected)
    })
  }

  // The axes are orthogonal. `presumed_safe` is the GOOD answer, merely an
  // inferred one — the inference rides on authority, not on pretending the
  // situation is worse than it is.
  it('presumed_safe is ok, not warn — authority carries the caveat, not severity', () => {
    expect(ipSeverity('presumed_safe')).toBe(ipSeverity('safe'))
  })
})

describe('scopeSeverity — Target alarm onto the same scale', () => {
  // D1 sits level with `exposed`: both are the thing the operator must not do,
  // both observed, both non-silenceable. One is an OPSEC failure, the other an
  // authorisation failure.
  it('a forbidden target is critical, like an exposed IP', () => {
    expect(scopeSeverity('excluded_target')).toBe('critical')
    expect(scopeSeverity('excluded_target')).toBe(ipSeverity('exposed'))
  })

  it('a proximity near-miss is warn, like an off-profile IP', () => {
    expect(scopeSeverity('adjacent_subnet')).toBe('warn')
    expect(scopeSeverity('adjacent_domain')).toBe('warn')
    expect(scopeSeverity('adjacent_subnet')).toBe(ipSeverity('off_profile'))
  })

  // The defect G-C1 exists to fix: the scope UI was `count > 0 ? red : green`.
  it('D1 and D2 are not the same step', () => {
    expect(scopeSeverity('excluded_target')).not.toBe(scopeSeverity('adjacent_domain'))
  })

  // D3 only reaches the list under `alertFloor: 'all'`. Giving it D2's step
  // would put the noise G-B3 removed back inside the violation list; giving it
  // `ok` would render a recorded departure green.
  it('an off-list target gets its own quiet step, distinct from D2', () => {
    expect(scopeSeverity('unrelated')).toBe('notice')
    expect(scopeSeverity('unrelated')).not.toBe(scopeSeverity('adjacent_subnet'))
    expect(scopeSeverity('unrelated')).not.toBe('ok')
  })
})

describe('worstSeverity', () => {
  it('an empty list is ok', () => expect(worstSeverity([])).toBe('ok'))
  it('one observed rule match outranks any number of inferences', () => {
    expect(worstSeverity(['warn', 'warn', 'critical', 'warn'])).toBe('critical')
  })
  it('orders the whole scale', () => {
    expect(worstSeverity(['ok', 'notice'])).toBe('notice')
    expect(worstSeverity(['notice', 'unknown'])).toBe('unknown')
    expect(worstSeverity(['unknown', 'warn'])).toBe('warn')
    expect(worstSeverity(['warn', 'critical'])).toBe('critical')
  })

  // A pile of off-list targets must not out-shout one forbidden-target hit.
  it('one critical outranks any number of notices', () => {
    expect(worstSeverity(['notice', 'notice', 'notice', 'critical'])).toBe('critical')
  })
})

describe('the scale is one scale, not two', () => {
  const LEVELS: Severity[] = ['ok', 'notice', 'unknown', 'warn', 'critical']

  it('every level has both a HUD hex and app classes', () => {
    for (const s of LEVELS) {
      expect(SEVERITY_HUD[s]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(SEVERITY_CLASS[s].dot).toBeTruthy()
      expect(SEVERITY_CLASS[s].text).toBeTruthy()
      expect(SEVERITY_CLASS[s].border).toBeTruthy()
    }
  })

  it('every level is a distinct colour — a scale with a repeat is not a scale', () => {
    expect(new Set(LEVELS.map((s) => SEVERITY_HUD[s])).size).toBe(LEVELS.length)
    expect(new Set(LEVELS.map((s) => SEVERITY_CLASS[s].dot)).size).toBe(LEVELS.length)
  })

  // The overlay and the app must not drift apart: `hud.ts` says its hexes MUST
  // match tailwind's soften map, and the scale is where both are read from.
  it('the HUD hexes come from the shared design tokens', () => {
    expect(SEVERITY_HUD.ok).toBe(HUD.green)
    expect(SEVERITY_HUD.unknown).toBe(HUD.amber)
    expect(SEVERITY_HUD.warn).toBe(HUD.orange)
    expect(SEVERITY_HUD.critical).toBe(HUD.red)
    expect(SEVERITY_HUD.notice).toBe(HUD.muted)
  })
})
