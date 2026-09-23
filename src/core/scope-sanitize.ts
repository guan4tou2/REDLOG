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
  'output', 'output_preview', 'stdout', 'stderr',
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
    const v = data[field]
    if (v == null) continue
    if (typeof v === 'string') {
      if (v.length > 0) out[field] = reason
    } else if (typeof v === 'object' || typeof v === 'number' || typeof v === 'boolean') {
      out[field] = reason
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

// ────── "For sharing" metadata masking (Option D, wave 2) ──────
//
// SCOPE_SANITIZED_FIELDS masks captured CONTENT (bodies, output). This second
// tier masks METADATA that identifies out-of-scope targets or carries sensitive
// values (headers with auth tokens, URLs with query-string credentials). Off by
// default ("For my records"); on in "For sharing" export preset.

/** Metadata fields blanked for out-of-scope events when metadata masking is on. */
export const SCOPE_METADATA_FIELDS = [
  'url', 'host',
  'request_headers', 'response_headers',
  'cookies', 'set_cookies',
  'query_name'
] as const

/** Operator-authored input that can carry target data as arguments. */
export const SCOPE_COMMAND_FIELDS = [
  'command'
] as const

/** Headers whose VALUE is scrubbed from in-scope events in sharing mode. */
export const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization',
  'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token'
])

/** Query-string parameter names whose values are scrubbed. */
const SENSITIVE_PARAMS = /^(token|key|password|passwd|secret|auth|api_key|access_token|refresh_token|session|sid)$/i

/** Scrub sensitive values from a URL's query string, preserving the path. */
export function scrubUrlQueryParams(url: string): string {
  try {
    const u = new URL(url)
    let changed = false
    for (const [name] of u.searchParams) {
      if (SENSITIVE_PARAMS.test(name)) { u.searchParams.set(name, '[REDACTED]'); changed = true }
    }
    return changed ? u.toString() : url
  } catch { return url }
}

/** Scrub sensitive header values from a header array (pairs or object). */
export function scrubSensitiveHeaders(
  headers: unknown,
  mode: 'scrub-sensitive' | 'redact-all'
): unknown {
  if (mode === 'redact-all') return '[redacted: out of scope]'
  if (Array.isArray(headers)) {
    return (headers as unknown[][]).map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return pair
      const name = String(pair[0]).toLowerCase()
      if (SENSITIVE_HEADERS.has(name)) return [pair[0], '[REDACTED]']
      return pair
    })
  }
  if (headers && typeof headers === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v
    }
    return out
  }
  return headers
}

/** Scrub cookie values while preserving names and attributes. */
export function scrubCookieValues(cookies: unknown): unknown {
  if (!Array.isArray(cookies)) return '[redacted: out of scope]'
  return (cookies as Record<string, unknown>[]).map((c) => ({
    ...c, value: '[REDACTED]'
  }))
}

export interface MetadataMaskOpts {
  /** The event's target classification. */
  outOfScope: boolean
}

/**
 * Metadata-level replacements for "For sharing" mode. Returns field→replacement
 * entries to merge into data, or null when nothing needs masking.
 *
 * For out-of-scope events: blanks all metadata fields.
 * For in-scope events: scrubs only sensitive values (auth headers, credential
 * query params, cookie values).
 */
export function scopeMetadataReplacements(
  data: Record<string, unknown>,
  opts: MetadataMaskOpts
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  let changed = false

  if (opts.outOfScope) {
    const reason = '[redacted: out-of-scope metadata]'
    for (const f of SCOPE_METADATA_FIELDS) {
      if (data[f] != null) { out[f] = reason; changed = true }
    }
    for (const f of SCOPE_COMMAND_FIELDS) {
      if (data[f] != null) { out[f] = '[redacted: out-of-scope command]'; changed = true }
    }
    if (data.target_id != null) { out.target_id = reason; changed = true }
  } else {
    // In-scope: surgical scrub of sensitive values only.
    if (typeof data.url === 'string') {
      const scrubbed = scrubUrlQueryParams(data.url)
      if (scrubbed !== data.url) { out.url = scrubbed; changed = true }
    }
    if (data.request_headers != null) {
      const scrubbed = scrubSensitiveHeaders(data.request_headers, 'scrub-sensitive')
      if (scrubbed !== data.request_headers) { out.request_headers = scrubbed; changed = true }
    }
    if (data.response_headers != null) {
      const scrubbed = scrubSensitiveHeaders(data.response_headers, 'scrub-sensitive')
      if (scrubbed !== data.response_headers) { out.response_headers = scrubbed; changed = true }
    }
    if (Array.isArray(data.cookies) && data.cookies.length > 0) {
      out.cookies = scrubCookieValues(data.cookies); changed = true
    }
    if (Array.isArray(data.set_cookies) && data.set_cookies.length > 0) {
      out.set_cookies = scrubCookieValues(data.set_cookies); changed = true
    }
  }

  return changed ? out : null
}
