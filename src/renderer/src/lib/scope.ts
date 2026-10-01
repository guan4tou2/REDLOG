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

