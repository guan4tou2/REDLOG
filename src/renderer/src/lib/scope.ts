// Client-side scope classification — delegates to the canonical evaluator.
// Kept as the renderer-side API surface so callers don't change.

import { matchPattern, evaluateScope, classifyScope } from '../../../core/scope-evaluator'

export { matchPattern as matchesScope }

/** Whether a scope is configured, by core's rule (`ScopePolicy.isConfigured`):
 *  at least one allowed target. Exclusions alone draw no boundary; they still
 *  mark the hosts they name as excluded. */
export function scopeConfigured(rules: { targets?: readonly string[] | null } | null | undefined): boolean {
  return (rules?.targets?.length ?? 0) > 0
}

export function hostInScope(
  host: string,
  targets: string[],
  excludeTargets: string[] = []
): boolean {
  if (!host) return true
  const d = evaluateScope(host, { targets, excludeTargets })
  return d.status === 'in-scope' || d.status === 'no-scope'
}

/** A recorded target against the project's rules: unknown (`null`) while no
 *  target is allowed. The Targets list and the Scope page's count of targets
 *  that produced no observation both read this, so the two tabs of one page
 *  cannot disagree about which targets are out of scope. */
export function targetInScope(
  target: string,
  rules: { targets?: readonly string[] | null; excludeTargets?: readonly string[] | null } | null | undefined
): boolean | null {
  if (!scopeConfigured(rules)) return null
  return hostInScope(target, [...(rules?.targets ?? [])], [...(rules?.excludeTargets ?? [])])
}


/** Display classification is deliberately richer than the capture/filter boolean. */
export function httpScopeState(url: string, policy: { targets: string[]; excludeTargets: string[] } | null): 'in-scope' | 'out-of-scope' | 'no-scope' | 'unknown' {
  if (!policy) return 'unknown'
  if (!policy.targets.length && !policy.excludeTargets.length) return 'no-scope'
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return 'unknown'
    const result = classifyScope(parsed.hostname, policy)
    return result.status === 'excluded' ? 'out-of-scope' : result.status
  } catch { return 'unknown' }
}
