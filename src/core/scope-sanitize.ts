// Scope-aware export masking (docs/DESIGN-OPEN-ITEMS.md §3, PRD A2).
//
// The four-layer redaction model masks DETECTED spans (a token that looks like
// a secret). It says nothing about SCOPE: an event whose target is out of the
// engagement's scope is client data RedLog had no authorisation to capture the
// content of, yet its body/preview fields ship verbatim in the bundle. This
// masks the content fields of out-of-scope events at export time — the source
// DB row and the chain hash are untouched (like layer-4 sanitize), only the
// exported bytes change.
//
// "Out of scope" here = the event has a target and that target matches NONE of
// the scope targets. When no scope is defined, nothing can be classified, so
// nothing is masked (the safe, non-breaking default for a caller that does not
// pass scope). This is deliberately broader than the scope MONITOR's "same
// root → warn, unrelated → ignore": for shipping bytes to a client, anything
// not in scope is treated as not-ours-to-hand-over.

import { classifyScopeTarget } from './alert/policies'

export interface ScopeForSanitize {
  targets: string[]
  /** Explicit excludes always count as out of scope. Optional. */
  excludeTargets?: string[]
}

/** The content fields masked for an out-of-scope event. Metadata (host, url,
 *  status, timing) stays — what a purple team needs to see "you touched X" —
 *  only the captured bytes go. */
export const SCOPE_SANITIZED_FIELDS = [
  'output', 'output_preview', 'stdout', 'stderr',
  'request_body', 'request_body_preview', 'response_body', 'response_preview',
  'ws_body', 'ws_preview', 'tcp_body', 'tcp_preview'
] as const

/**
 * True when this event carries a target that matches none of the scope targets.
 * A no-target event, or an empty scope, is never classified as out-of-scope
 * (we cannot tell, so we do not mask).
 */
export function isOutOfScope(targetId: string | null | undefined, scope: ScopeForSanitize | undefined): boolean {
  if (!targetId || !scope || scope.targets.length === 0) return false
  // The authoritative, CIDR- and domain-aware classifier the scope monitor
  // uses — so 10.1.2.3 correctly counts as in-scope under 10.0.0.0/8 and is
  // never masked. Only a target the scope engine places OUTSIDE the include
  // list (unrelated, same-root-but-out, or explicitly excluded) is masked.
  const verdict = classifyScopeTarget(targetId, { targets: scope.targets, excludeTargets: scope.excludeTargets ?? [] })
  return verdict.distance !== 'in_scope'
}

/**
 * Replacement values for the content fields of an out-of-scope event, or null
 * when the event is in scope / unclassifiable / carries no content field. The
 * replacement names the reason so a bundle reader sees why the bytes are gone.
 */
export function scopeMaskReplacements(
  data: Record<string, unknown>,
  targetId: string | null | undefined,
  scope: ScopeForSanitize | undefined
): Record<string, string> | null {
  if (!isOutOfScope(targetId, scope)) return null
  const out: Record<string, string> = {}
  for (const field of SCOPE_SANITIZED_FIELDS) {
    if (typeof data[field] === 'string' && (data[field] as string).length > 0) {
      out[field] = '[redacted: out of scope]'
    }
  }
  return Object.keys(out).length > 0 ? out : null
}
