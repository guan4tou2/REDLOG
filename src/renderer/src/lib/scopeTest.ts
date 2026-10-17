// "Test a URL" in Settings ▸ Scope: what would the rules below say about this
// host? A preview only — it reads the lists as they are on screen and writes
// nothing, so it cannot become evidence by accident.
//
// It adds no decision of its own. The verdict is `classifyScope`'s; this only
// separates the two states that function folds together (nothing typed that
// names a host, and a host outside the list) and names the two things the
// rules never say aloud: that a plain domain does not cover its subdomains, and
// that an exclusion wins over an inclusion.
import { classifyScope, normalizeSubject, matchPattern, type ScopePolicy } from '../../../core/scope-evaluator'

export type ScopeTestResult =
  | { kind: 'empty' }
  | { kind: 'unknown' }
  | { kind: 'unset' }
  | { kind: 'in-scope'; matchedBy: string; viaWildcard: boolean }
  | { kind: 'excluded'; matchedBy: string; alsoIncluded: boolean }
  | { kind: 'out-of-scope'; adjacentDomain: boolean; /** a plain-domain rule that stops at its own name */ subdomainOf: string | null }

const HOSTNAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/
const IPV6 = /^[0-9a-f:.]+$/

function isHostLike(subject: string): boolean {
  if (subject.includes(':')) return IPV6.test(subject) && (subject.match(/:/g) ?? []).length >= 2
  return HOSTNAME.test(subject)
}

export function testScopeSubject(input: string, policy: ScopePolicy): ScopeTestResult {
  if (input.trim() === '') return { kind: 'empty' }
  const subject = normalizeSubject(input)
  if (!subject || !isHostLike(subject)) return { kind: 'unknown' }

  const c = classifyScope(subject, policy)
  if (c.status === 'no-scope') return { kind: 'unset' }
  if (c.status === 'in-scope') {
    const matchedBy = c.matchedBy as string
    return { kind: 'in-scope', matchedBy, viaWildcard: matchedBy.trim().startsWith('*.') }
  }
  if (c.status === 'excluded') {
    return {
      kind: 'excluded',
      matchedBy: c.matchedBy as string,
      alsoIncluded: policy.targets.some((t) => matchPattern(subject, t))
    }
  }
  const subdomainOf = policy.targets
    .map((t) => t.trim().toLowerCase())
    .find((t) => !t.startsWith('*.') && !t.includes('/') && !t.includes(':') && t.includes('.') && subject.endsWith(`.${t}`)) ?? null
  return { kind: 'out-of-scope', adjacentDomain: c.distance === 'adjacent_domain', subdomainOf }
}
