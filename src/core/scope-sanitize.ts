// Scope-aware export masking (docs/archive/DESIGN-OPEN-ITEMS.md §3, PRD A2).
//
// The four-layer redaction model masks DETECTED spans (a token that looks like
// a secret). It says nothing about SCOPE: an event whose target is out of the
// engagement's scope is client data RedLog had no authorisation to capture the
// content of. This masks the content of out-of-scope events at export time —
// the source DB row and the chain hash are untouched (like layer-4 sanitize),
// only the exported bytes change, and a bundle lists every rewritten row in
// `manifest.evidence.transformedEventIds`.
//
// The contract, field by field (SCOPE_MASKED_FIELDS below is the whole list):
//
//   Metadata STAYS — what a purple team needs to see "you touched X, this
//   way, at this time": the target and host, the scheme, host and path of a
//   URL, method, port, status, sizes, content type, timing, flow and stream
//   ids, HTTP version, the local source address and pid, the server's TLS
//   parameters and certificate, DNS names and address answers, and the NAMES
//   of headers, cookies and query parameters, in order and with duplicates.
//
//   Content GOES — every byte the target or the operator's tool sent that is
//   not one of the above: bodies and previews, the HTTP addon's parsed copy of
//   the request (`params`), every header value (Authorization, Cookie, a
//   redirect's Location), every cookie value, query-string values, a URL's
//   fragment and userinfo, a page title, browser console text, DNS answers
//   that are not addresses or names.
//
// A value is replaced by the marker, not removed, so a reader sees that
// something was there and why it is not. Inside a URL the marker is
// percent-encoded, so the URL still parses and its query still reads back as
// the marker. A structure this module does not recognise is replaced whole: an
// unknown shape never passes through because nothing here knew how to walk it.
//
// "Out of scope" here = the event has a target and that target matches NONE of
// the scope targets, or matches an exclude. "Unclassified" = a scope with at
// least one target is defined and the event has no target: it is masked the
// same way, with its own marker. When no scope is supplied nothing is masked
// (masking off, or a caller that does not pass scope). This is deliberately
// broader than the scope MONITOR's "same root → warn, unrelated → ignore": for
// shipping bytes to a client, anything not in scope is treated as
// not-ours-to-hand-over.

import { classifyScope } from './scope-evaluator'

export interface ScopeForSanitize {
  targets: string[]
  /** Explicit excludes always count as out of scope. Optional. */
  excludeTargets?: string[]
  /** Personal/local traffic: matched rows are DROPPED entirely on export
   *  (not masked). Same syntax as excludeTargets. Optional. */
  personalDomains?: string[]
}

/** Returned by a field masker when the value carries nothing to mask. */
const KEEP = Symbol('keep')
type FieldMasker = (value: unknown, marker: string, data: Record<string, unknown>) => unknown

/** A body or preview: the whole value goes. An empty string stays — there is
 *  nothing in it — and is how an absent preview has always exported. */
function maskWhole(value: unknown, marker: string): unknown {
  if (typeof value === 'string') return value.length > 0 ? marker : KEEP
  if (typeof value === 'object' || typeof value === 'number' || typeof value === 'boolean') return marker
  return KEEP
}

/** The addon's own entry when a request had more headers than it keeps: its
 *  value is RedLog's count, not the target's bytes. Recognised only as the last
 *  entry in exactly the addon's wording, so a header of that name sent by the
 *  target is masked like any other. */
const TRUNCATION_HEADER = 'X-RedLog-Truncated'
const TRUNCATION_VALUE = /^\d+ total, showing \d+$/

/** `[[name, value], …]`, the only header shape a producer writes
 *  (hooks/mitmproxy-addon.py `_extract_all_headers`). Names stay in order with
 *  duplicates; every value is the marker. Any other shape — an object, an
 *  entry that is not a `[string, …]` pair — is masked whole. */
function maskHeaders(value: unknown, marker: string): unknown {
  if (!Array.isArray(value)) return maskWhole(value, marker)
  let changed = false
  const out: unknown[] = []
  for (let i = 0; i < value.length; i++) {
    const pair: unknown = value[i]
    if (!Array.isArray(pair) || pair.length === 0 || pair.length > 2 || typeof pair[0] !== 'string') return marker
    const name = pair[0]
    if (pair.length === 1) { out.push(pair); continue }
    const own = i === value.length - 1 && name === TRUNCATION_HEADER && typeof pair[1] === 'string' && TRUNCATION_VALUE.test(pair[1])
    if (own) out.push(pair)
    else { out.push([name, marker]); changed = true }
  }
  return changed ? out : KEEP
}

/** Cookie attributes that describe the cookie rather than carry it
 *  (hooks/mitmproxy-addon.py `_extract_set_cookies`). */
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'expires', 'max_age', 'secure', 'httponly', 'samesite'])

/** `[{name, value, …attributes}, …]` (`_extract_request_cookies`,
 *  `_extract_set_cookies`). Names and the attributes above stay; the value,
 *  and any key this does not know, is the marker. Any other shape is masked
 *  whole. */
function maskCookies(value: unknown, marker: string): unknown {
  if (!Array.isArray(value)) return maskWhole(value, marker)
  let changed = false
  const out: unknown[] = []
  for (const cookie of value as unknown[]) {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie) || typeof (cookie as { name?: unknown }).name !== 'string') return marker
    const masked: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(cookie as Record<string, unknown>)) {
      const keep = key === 'name' || COOKIE_ATTRIBUTES.has(key)
      masked[key] = keep ? v : marker
      if (!keep) changed = true
    }
    out.push(masked)
  }
  return changed ? out : KEEP
}

/** Only for URL-shaped text: whether it parses, absolutely or against a base. */
function parses(text: string): boolean {
  try { new URL(text, 'http://placeholder.invalid/'); return true } catch { return false }
}

/**
 * A URL with its scheme, host and path kept and its content replaced: every
 * query value (names stay, an empty value stays empty, a bare `?token` is the
 * marker), every `;name=value` path parameter's value, the userinfo, and the
 * fragment, which is dropped. Text that does not parse keeps only what comes
 * before the first `?` or `#`. A `data:` or `javascript:` URL is all content.
 * Returns the input itself when there was nothing to mask.
 */
function maskUrlText(url: string, marker: string): string {
  const enc = encodeURIComponent(marker)
  if (/^\s*(?:data|javascript):/i.test(url)) return marker
  const cut = url.search(/[?#]/)
  let base = cut < 0 ? url : url.slice(0, cut)
  const hasQuery = cut >= 0 && url[cut] === '?'
  const afterQuery = hasQuery ? url.slice(cut + 1) : ''
  const hash = afterQuery.indexOf('#')
  const query = hash < 0 ? afterQuery : afterQuery.slice(0, hash)
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)/i.exec(base)
  if (authority && authority[2].includes('@')) {
    base = authority[1] + enc + authority[2].slice(authority[2].lastIndexOf('@')) + base.slice(authority[0].length)
  }
  const pathStart = authority ? authority[0].length : 0
  base = base.slice(0, pathStart) + base.slice(pathStart).replace(/;([^;/=]*)=[^;/]*/g, (_m, name: string) => `;${name}=${enc}`)
  if (!hasQuery) return base
  if (!parses(url)) return `${base}?${enc}`
  const masked = query.split('&').map((part) => {
    if (part === '') return part
    const eq = part.indexOf('=')
    if (eq < 0) return enc
    return eq === part.length - 1 ? part : `${part.slice(0, eq + 1)}${enc}`
  }).join('&')
  return `${base}?${masked}`
}

function maskUrl(value: unknown, marker: string): unknown {
  if (typeof value !== 'string') return value == null ? KEEP : marker
  const masked = maskUrlText(value, marker)
  return masked === value ? KEEP : masked
}

/** DNS answer types whose data is a name or an address: what was resolved,
 *  not what a record said. Any other answer's data (TXT, and anything this
 *  does not know) is the marker. */
const NAME_OR_ADDRESS_ANSWERS = new Set(['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'SRV', 'SOA', 'DNAME', 'HTTPS', 'SVCB'])

function maskDnsAnswers(value: unknown, marker: string): unknown {
  if (!Array.isArray(value)) return maskWhole(value, marker)
  let changed = false
  const out: unknown[] = []
  for (const answer of value as unknown[]) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return marker
    const a = answer as Record<string, unknown>
    if ('data' in a && !(typeof a.type === 'string' && NAME_OR_ADDRESS_ANSWERS.has(a.type) && typeof a.data === 'string')) {
      out.push({ ...a, data: marker }); changed = true
    } else out.push(a)
  }
  return changed ? out : KEEP
}

/** Browser rows from the CDP connector (src/main/services/cdp-connector.ts). */
const BROWSER_CONSOLE_SUBTYPES = new Set(['console_log', 'console_info', 'console_warn', 'console_error', 'console_debug', 'console_trace', 'exception', 'log_entry'])

/** A masker that applies only to rows of the given subtypes; others keep the
 *  field, because the same key means something else on them (a shell row's
 *  `source` names its terminal, a note's `title` is the operator's own). */
function forSubtypes(subtypes: ReadonlySet<string>, masker: FieldMasker): FieldMasker {
  return (value, marker, data) => typeof data.subtype === 'string' && subtypes.has(data.subtype) ? masker(value, marker, data) : KEEP
}

const NAVIGATION = new Set(['navigation'])
/** The addon's HTTP rows. `path` is gated to them: on a file row it is a file
 *  path, where `#` or `;` is part of the name. */
const HTTP_SUBTYPES = new Set(['http_request_start', 'http_response', 'http_error', 'http_request_dropped', 'http_response_chunk', 'ws_message', 'websocket_end'])

/** A navigation's description is `→ host`, or the start of the URL when the
 *  connector found no host. */
function maskNavigationDescription(value: unknown, marker: string, data: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return maskWhole(value, marker)
  if (value === `→ ${String(data.host ?? '')}`) return KEEP
  const masked = value.startsWith('→ ') ? `→ ${maskUrlText(value.slice(2), marker)}` : marker
  return masked === value ? KEEP : masked
}

/** Every field scope masking rewrites, and how. A field not listed here is
 *  metadata and exports as recorded. */
const SCOPE_MASKED_FIELDS: Readonly<Record<string, FieldMasker>> = {
  // Captured bodies and previews: command output, HTTP/WS/TCP payloads.
  output: maskWhole, output_preview: maskWhole, stdout: maskWhole, stderr: maskWhole, output_body: maskWhole,
  request_body: maskWhole, request_body_preview: maskWhole, response_body: maskWhole, response_preview: maskWhole,
  ws_body: maskWhole, ws_preview: maskWhole, tcp_body: maskWhole, tcp_preview: maskWhole,
  // The addon's parsed copy of the request: query, form, JSON, multipart, raw.
  params: maskWhole,
  request_headers: maskHeaders, response_headers: maskHeaders,
  cookies: maskCookies, set_cookies: maskCookies,
  url: maskUrl, path: forSubtypes(HTTP_SUBTYPES, maskUrl), pretty_url: maskUrl, prev_url: maskUrl,
  answers: forSubtypes(new Set(['dns_response']), maskDnsAnswers),
  // cookie_change: truncated hashes of a session cookie's old and new value.
  old_hash: forSubtypes(new Set(['cookie_change']), maskWhole),
  new_hash: forSubtypes(new Set(['cookie_change']), maskWhole),
  title: forSubtypes(NAVIGATION, maskWhole),
  description: forSubtypes(NAVIGATION, maskNavigationDescription),
  message: forSubtypes(BROWSER_CONSOLE_SUBTYPES, maskWhole),
  stack_trace: forSubtypes(BROWSER_CONSOLE_SUBTYPES, maskWhole),
  source: forSubtypes(BROWSER_CONSOLE_SUBTYPES, maskUrl)
}
const MASKED_FIELD_NAMES = Object.keys(SCOPE_MASKED_FIELDS)

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
 * event, or null when the event is in scope / carries no content to mask. Each
 * value replaces the top-level field of the same name. The marker names the
 * reason so a bundle reader sees why the bytes are gone. An in-scope event
 * returns before any field is read.
 */
export function scopeMaskReplacements(
  data: Record<string, unknown>,
  targetId: string | null | undefined,
  scope: ScopeForSanitize | undefined
): Record<string, unknown> | null {
  const outOfScope = isOutOfScope(targetId, scope)
  const unclassified = !outOfScope && isUnclassifiedScope(targetId, scope)
  if (!outOfScope && !unclassified) return null
  const reason = outOfScope ? '[redacted: out of scope]' : '[redacted: no target — scope unclassified]'
  const out: Record<string, unknown> = {}
  for (const field of MASKED_FIELD_NAMES) {
    const v = data[field] ?? (field === 'output_body' ? data.output_body_ref : undefined)
    if (v == null) continue
    const masked = SCOPE_MASKED_FIELDS[field](v, reason, data)
    if (masked !== KEEP) out[field] = masked
  }
  return Object.keys(out).length > 0 ? out : null
}
