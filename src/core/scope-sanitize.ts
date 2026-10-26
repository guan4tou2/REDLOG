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

import { classifyScope } from './scope-evaluator'

export interface ScopeForSanitize {
  targets: string[]
  /** Explicit excludes always count as out of scope. Optional. */
  excludeTargets?: string[]
  /** Personal/local traffic: matched rows are DROPPED entirely on export
   *  (not masked). Same syntax as excludeTargets. Optional. */
  personalDomains?: string[]
}

/** The content fields masked for an out-of-scope event. Metadata (host, url,
 *  status, timing) stays — what a purple team needs to see "you touched X" —
 *  only the captured bytes go. */
export const SCOPE_SANITIZED_FIELDS = [
  'output', 'output_preview', 'stdout', 'stderr', 'output_body',
  'request_body', 'request_body_preview', 'response_body', 'response_preview',
  'ws_body', 'ws_preview', 'tcp_body', 'tcp_preview'
] as const

/**
 * True when the event's target matches a personal/local domain pattern.
 * Personal rows are DROPPED entirely on export (not masked).
 * Uses only the "rung 1" explicit-exclude match — residual/inferred
 * buckets are ignored so a non-personal target doesn't false-positive.
 */
export function isPersonalDomain(targetId: string | null | undefined, scope: ScopeForSanitize | undefined): boolean {
  if (!scope?.personalDomains?.length) return false
  if (!targetId) return false
  return classifyScope(targetId, { targets: [], excludeTargets: scope.personalDomains }).distance === 'excluded'
}

/**
 * True when this event carries a target that matches none of the scope targets.
 * An empty scope is never classified as out-of-scope (can't classify).
 */
export function isOutOfScope(targetId: string | null | undefined, scope: ScopeForSanitize | undefined): boolean {
  // No early exit for "no allowlist": that returned false before exclusions
  // were ever checked, so an exclude-only project exported its explicitly
  // excluded targets unmasked — against this interface's own contract that
  // excludes always count as out of scope. The classifier already treats a
  // missing allowlist as "nothing is out of scope except what is excluded".
  if (!scope || !targetId) return false
  return classifyScope(targetId, { targets: scope.targets, excludeTargets: scope.excludeTargets ?? [] }).distance !== 'in_scope'
}

/**
 * True when scope is defined, the event carries body content, but has no
 * target — meaning we cannot determine whether it's in or out of scope.
 */
export function isUnclassifiedScope(targetId: string | null | undefined, scope: ScopeForSanitize | undefined): boolean {
  if (!scope || scope.targets.length === 0) return false
  return !targetId
}

/**
 * Replacement values for the content fields of an out-of-scope or unclassified
 * event, or null when the event is in scope / carries no content field. The
 * replacement names the reason so a bundle reader sees why the bytes are gone.
 */
export function scopeMaskReplacements(
  data: Record<string, unknown>,
  targetId: string | null | undefined,
  scope: ScopeForSanitize | undefined
): Record<string, string> | null {
  const outOfScope = isOutOfScope(targetId, scope)
  const unclassified = !outOfScope && isUnclassifiedScope(targetId, scope)
  if (!outOfScope && !unclassified) return null
  const reason = outOfScope ? '[redacted: out of scope]' : '[redacted: no target — scope unclassified]'
  const out: Record<string, string> = {}
  for (const field of SCOPE_SANITIZED_FIELDS) {
    const v = data[field] ?? (field === 'output_body' ? data.output_body_ref : undefined)
    if (v == null) continue
    if (typeof v === 'string') {
      if (v.length > 0) out[field] = reason
    } else if (typeof v === 'object' || typeof v === 'number' || typeof v === 'boolean') {
      out[field] = reason
    }
  }
  return Object.keys(out).length > 0 ? out : null
}
