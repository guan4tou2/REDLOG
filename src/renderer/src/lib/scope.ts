// Client-side scope classification — delegates to the canonical evaluator.
// Kept as the renderer-side API surface so callers don't change.

import { matchPattern, evaluateScope } from '../../../core/scope-evaluator'

export { matchPattern as matchesScope }

export function hostInScope(
  host: string,
  targets: string[],
  excludeTargets: string[] = []
): boolean {
  if (!host) return true
  const d = evaluateScope(host, { targets, excludeTargets })
  return d.status === 'in-scope' || d.status === 'no-scope'
}

export function hostOutOfScope(
  host: string,
  targets: string[],
  excludeTargets: string[] = []
): boolean {
  if (!host) return false
  if (targets.length === 0 && excludeTargets.length === 0) return false
  return !hostInScope(host, targets, excludeTargets)
}
