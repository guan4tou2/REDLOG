// Spec 023 T001-T004 — RED.
//
// Scope had two classifiers: `evaluateScope` (the investigation filter) and
// `classifyScopeTarget` (export masking, recompute and the live alarm, living
// inside `alert/`). They agree on ordinary input by accident. These pin down
// where they did not, and the structure that let them drift.
//
// The case that matters most is the first: the adjacency rungs judged the raw
// subject, so a host adjacent to scope was a warning when typed in lowercase
// and a silent notice when typed with a capital, a port, a trailing dot or a
// scheme. The shell target extractor keeps the case the operator typed.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { evaluateScope } from '../src/core/scope-evaluator'
import { classifyScopeTarget } from '../src/core/alert/policies'
import { isOutOfScope, isPersonalDomain } from '../src/core/scope-sanitize'

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

const scope = { targets: ['example.com', '10.0.0.5'], excludeTargets: ['admin.example.com'] }

describe('one adjacent host, however it is written (T001)', () => {
  const domainForms = [
    'sub.example.com',
    'SUB.EXAMPLE.COM',
    'Sub.Example.com',
    'sub.example.com.',
    'sub.example.com:8443',
    'https://sub.example.com/login',
    'http://user@sub.example.com:8080/x'
  ]
  const subnetForms = ['10.0.0.99', '10.0.0.99:22', 'http://10.0.0.99/', 'https://10.0.0.99:8443/a']

  it('classifies every form of an adjacent domain as adjacent_domain', () => {
    for (const s of domainForms) {
      expect({ s, distance: classifyScopeTarget(s, scope).distance }).toEqual({ s, distance: 'adjacent_domain' })
    }
  })

  it('classifies every form of an adjacent subnet host as adjacent_subnet', () => {
    for (const s of subnetForms) {
      expect({ s, distance: classifyScopeTarget(s, scope).distance }).toEqual({ s, distance: 'adjacent_subnet' })
    }
  })

  it('gives every form the same severity, so a capital cannot silence a warning', () => {
    const severities = new Set(domainForms.map((s) => classifyScopeTarget(s, scope).severity))
    expect([...severities]).toEqual(['warning'])
  })

  it('matches a scope entry written in capitals against a lowercase subject', () => {
    const upper = { targets: ['EXAMPLE.COM'], excludeTargets: [] }
    expect(classifyScopeTarget('example.com', upper).distance).toBe('in_scope')
    expect(classifyScopeTarget('sub.example.com', upper).distance).toBe('adjacent_domain')
  })
})

describe('a project with exclusions but no allowlist (T002)', () => {
  const excludeOnly = { targets: [], excludeTargets: ['admin.example.com'] }

  it('treats a non-excluded target as in scope, not as unrelated', () => {
    expect(classifyScopeTarget('shop.example.com', excludeOnly).distance).toBe('in_scope')
    expect(classifyScopeTarget('shop.example.com', excludeOnly).authority).toBe('unknown')
  })

  it('masks an explicitly excluded target on export, and nothing else', () => {
    // `isOutOfScope` returned false for any project without an allowlist
    // before checking exclusions, so an exclude-only project exported its
    // explicitly excluded targets unmasked — against the interface's own
    // contract that excludes always count as out of scope.
    const sanitizeScope = { targets: [], excludeTargets: ['admin.example.com'] }
    expect(isOutOfScope('shop.example.com', sanitizeScope)).toBe(false)
    expect(evaluateScope('shop.example.com', excludeOnly).status).toBe('no-scope')
    expect(isOutOfScope('admin.example.com', sanitizeScope)).toBe(true)
  })

  it('keeps personal-domain membership exact', () => {
    const withPersonal = { targets: ['example.com'], personalDomains: ['*.slack.com'] }
    expect(isPersonalDomain('app.slack.com', withPersonal)).toBe(true)
    expect(isPersonalDomain('example.com', withPersonal)).toBe(false)
  })

  it('still reports the excluded target as excluded in both views', () => {
    expect(classifyScopeTarget('admin.example.com', excludeOnly).distance).toBe('excluded')
    expect(evaluateScope('admin.example.com', excludeOnly).status).toBe('excluded')
  })
})

describe('the filter status and the distance never disagree (T003)', () => {
  // The distance a filter status implies. `no-scope` and `in-scope` both mean
  // "not out of scope"; the filter distinguishes whether a scope exists.
  const statusFor = (distance: string, hasAllowlist: boolean): string => {
    if (distance === 'excluded') return 'excluded'
    if (distance === 'in_scope') return hasAllowlist ? 'in-scope' : 'no-scope'
    return 'out-of-scope'
  }

  const scopes = [
    { targets: [], excludeTargets: [] },
    { targets: [], excludeTargets: ['admin.example.com'] },
    { targets: ['example.com'], excludeTargets: [] },
    { targets: ['*.example.com', '10.0.0.0/24'], excludeTargets: ['admin.example.com'] },
    { targets: ['EXAMPLE.COM', '10.0.0.5'], excludeTargets: ['ADMIN.EXAMPLE.COM'] }
  ]
  const subjects = [
    'example.com', 'EXAMPLE.COM', 'example.com.', 'https://example.com/login', 'example.com:443',
    'sub.example.com', 'Sub.Example.Com', 'admin.example.com', 'Admin.Example.com',
    'notexample.com', '10.0.0.5', '10.0.0.5:22', '10.0.0.99', '10.0.1.1', 'evil.test', ''
  ]

  for (const sc of scopes) {
    it(`agrees for targets=${JSON.stringify(sc.targets)} excludes=${JSON.stringify(sc.excludeTargets)}`, () => {
      for (const s of subjects) {
        const distance = classifyScopeTarget(s, sc).distance
        const status = evaluateScope(s, sc).status
        expect({ s, status }).toEqual({ s, status: statusFor(distance, sc.targets.length > 0) })
      }
    })
  }
})

describe('scope classification has one home (T004)', () => {
  it('is decided in scope-evaluator', () => {
    expect(read('src/core/scope-evaluator.ts')).toMatch(/export function classifyScope\(/)
  })

  it('does not decide distance inside the alert subsystem', () => {
    const policies = read('src/core/alert/policies.ts')
    // The alert module maps a distance to authority and severity; it must not
    // run the rungs itself.
    expect(policies).not.toMatch(/matchPattern\(/)
    expect(policies).not.toMatch(/function registrableDomain|function subnetOf/)
  })

  it('keeps export masking free of the alert subsystem', () => {
    expect(read('src/core/scope-sanitize.ts')).not.toMatch(/from '\.\/alert/)
  })

  it('declares ScopeSnapshot once', () => {
    const files = ['src/core/alert/policies.ts', 'src/core/scope-recompute.ts', 'src/core/scope-evaluator.ts']
    const declarations = files.filter((f) => /export interface ScopeSnapshot\b/.test(read(f)))
    expect(declarations).toHaveLength(1)
  })
})
