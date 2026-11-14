// Scope-aware export masking (docs/archive/DESIGN-OPEN-ITEMS.md §3, PRD A2).
//
// The four-layer redaction model masks DETECTED spans (a token that looks like
// a secret). It says nothing about SCOPE: an event whose target is out of the
// engagement's scope is client data RedLog had no authorisation to capture the
// content of. This masks named fields of out-of-scope events at export time —
// the source DB row and the chain hash are untouched (like layer-4 sanitize),
// only the exported bytes change, and a bundle lists every rewritten row in
// `manifest.evidence.transformedEventIds`.
//
// What the code does, exactly. It is a DENYLIST: SCOPE_MASKED_FIELDS below
// names every top-level `data` field that is rewritten, and how; EVERY OTHER
// FIELD IS EXPORTED AS RECORDED. The masked fields:
//
//   - bodies and previews (`output`, `stdout`, `stderr`, `request_body`,
//     `response_preview`, `ws_body`, `tcp_preview`, …) and the HTTP addon's
//     parsed copy of the request, `params`: replaced whole;
//   - `request_headers` / `response_headers`: every value (Authorization,
//     Cookie, a redirect's Location); the names stay, in order, with
//     duplicates;
//   - `cookies` / `set_cookies`: every value; names and cookie attributes stay;
//   - `url`, `pretty_url`, `prev_url`, and `path` on HTTP rows: query values,
//     a query piece with no value, `;name=value` path-parameter values, the
//     userinfo of a URL written with `://`, and the fragment (dropped);
//     scheme, host, path and the names of valued parameters stay; a URL that
//     does not parse keeps only what precedes its first `?` or `#`; a
//     `data:` / `javascript:` / `vbscript:` URL is masked whole;
//   - URLs found inside a `description` (file_transfer, credential_use and
//     other derived rows), and the URL in a scope_violation's `action`;
//   - loot `matches[].preview`; DNS answers that are not names or addresses;
//     a navigation's `title`; browser console `message`, `stack_trace`,
//     `source`; cookie_change's value hashes; the error text of `http_error`
//     and `tcp_end` past a known content-free class.
//
// What stays, on purpose or for want of a decision:
//
//   - COMMAND TEXT IS NOT MASKED in this version, on any row: `command`,
//     `argv`, a loot row's `source`, the action of a scope_violation raised by
//     a shell command or an agent tool. The owner has decided that commands
//     are masked at export time (「指令只需要在輸出時遮蔽就好吧」); that is
//     not built yet.
//   - Path segments (`/reset/<token>`), the names of headers, cookies and
//     parameters, `content_type` and its parameters, `tls.*`, host, method,
//     status, sizes, timing, ids.
//   - A row derived from an out-of-scope row (scope_violation, loot,
//     file_transfer, credential_use, pivot, cleanup) is masked only in the
//     fields named here, and only when its own target is out of scope.
//   - Userinfo written in a non-standard form (not after `://`) is not
//     recognised; no producer emits such URLs today, and it is a known gap.
//   - A field this module does not name is exported whole, whatever it holds:
//     test/scope-mask-field-ratchet.test.ts fails when a recorded producer
//     payload carries a key nobody has classified.
//
// Within a masked field the marker replaces a value rather than removing it,
// so a reader sees that something was there and why it is not. Inside a URL
// the marker is percent-encoded, so the URL still parses and its query reads
// back as the marker. A structure a masker does not recognise (headers that
// are not `[name, value]` pairs, cookies without a name, …) is replaced whole.
//
// "Out of scope" here = the event has a target and that target matches NONE of
// the scope targets, or matches an exclude. "Unclassified" = a scope with at
// least one target is defined and the event has no target: it is masked the
// same way, with its own marker. With an exclude-only scope a row with no
// target is not masked. When no scope is supplied nothing is masked. Masking
// applies only to out-of-scope and unclassified rows: an in-scope row that
// carries out-of-scope content (a Referer, a prev_url) is not touched.

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

// ── URLs ────────────────────────────────────────────────────────────────────

/** Schemes whose whole text is content. */
const OPAQUE_SCHEMES = new Set(['data', 'javascript', 'vbscript'])

/** The scheme as WHATWG would read it: leading C0 controls and spaces skipped,
 *  tab and newline ignored. Null when there is none. A scheme with another
 *  control character in it is reported as opaque, so it is masked whole. */
function schemeOf(url: string): string | null {
  let i = 0
  while (i < url.length && url.charCodeAt(i) <= 0x20) i++
  let scheme = ''
  for (; i < url.length; i++) {
    const ch = url[i]
    const c = url.charCodeAt(i)
    if (ch === ':') return scheme.length > 0 && /^[a-z]/i.test(scheme) ? scheme.toLowerCase() : null
    if (ch === '\t' || ch === '\n' || ch === '\r') continue
    if (c < 0x20 || c === 0x7f) return 'javascript'
    if (!/[A-Za-z0-9+.-]/.test(ch)) return null
    scheme += ch
  }
  return null
}

/** Only for URL-shaped text: whether it parses, absolutely or against a base. */
function parses(text: string): boolean {
  try { new URL(text, 'http://placeholder.invalid/'); return true } catch { return false }
}

/** True when the value part of a query piece (from its first `=`) is empty or
 *  only more `=`: `tok`, `tok=`, `c2VjcmV0==` carry no value, so the piece is a
 *  token, not a parameter name. */
function valueless(piece: string, eq: number): boolean {
  for (let i = eq + 1; i < piece.length; i++) if (piece[i] !== '=') return false
  return true
}

/** Query values become the marker. A piece without a value is a token and is
 *  masked whole — in a single-piece query and among others alike, because
 *  nothing tells `?debug=` from `?<secret>=`. */
function maskQuery(query: string, enc: string): string {
  return query.split('&').map((piece) => {
    if (piece === '') return piece
    const eq = piece.indexOf('=')
    if (eq <= 0 || valueless(piece, eq)) return enc
    return `${piece.slice(0, eq + 1)}${enc}`
  }).join('&')
}

/**
 * A URL with its scheme, host and path kept and its content replaced: every
 * query value, every query piece with no value, every `;name=value` path
 * parameter's value, the userinfo of a URL written with `://`, and the
 * fragment, which is dropped. Text that does not parse keeps only what comes
 * before the first `?` or `#`. A `data:`, `javascript:` or `vbscript:` URL, or
 * one whose scheme holds a control character, is all content.
 * Returns the input itself when there was nothing to mask.
 */
function maskUrlText(url: string, marker: string): string {
  const enc = encodeURIComponent(marker)
  const scheme = schemeOf(url)
  if (scheme && OPAQUE_SCHEMES.has(scheme)) return marker
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
  return `${base}?${maskQuery(query, enc)}`
}

function maskUrl(value: unknown, marker: string): unknown {
  if (typeof value !== 'string') return value == null ? KEEP : marker
  const masked = maskUrlText(value, marker)
  return masked === value ? KEEP : masked
}

const isSchemeChar = (c: number): boolean =>
  (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e
const isAlpha = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)
/** Where a URL embedded in prose ends. */
const isUrlStop = (c: number): boolean => c <= 0x20 || c === 0x22 || c === 0x27 || c === 0x60 || c === 0x3c || c === 0x3e

/** Every `scheme://…` in free text, up to whitespace or a quote, through the
 *  URL masker; the text around them stays. One forward pass: each walk back
 *  over a scheme stops at the end of the previous URL. */
function maskUrlsInText(text: string, marker: string): string {
  let out = ''
  let last = 0
  let i = text.indexOf('://')
  while (i >= 0) {
    let s = i
    while (s > last && isSchemeChar(text.charCodeAt(s - 1))) s--
    while (s < i && !isAlpha(text.charCodeAt(s))) s++
    if (s === i) { i = text.indexOf('://', i + 3); continue }
    let e = i + 3
    while (e < text.length && !isUrlStop(text.charCodeAt(e))) e++
    out += text.slice(last, s) + maskUrlText(text.slice(s, e), marker)
    last = e
    i = text.indexOf('://', e)
  }
  return last === 0 ? text : out + text.slice(last)
}

function maskTextUrls(value: unknown, marker: string): unknown {
  if (typeof value !== 'string') return maskWhole(value, marker)
  const masked = maskUrlsInText(value, marker)
  return masked === value ? KEEP : masked
}

/** DNS answer types whose data is a name or an address: what was resolved,
 *  not what a record said. Any other answer's data — TXT, HTTPS and SVCB
 *  (`ech=`, `keyNNNNN=` values), and anything this does not know — is the
 *  marker. */
const NAME_OR_ADDRESS_ANSWERS = new Set(['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'SRV', 'SOA', 'DNAME'])

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

/** Loot `matches`: `type`, `confidence` and plugin provenance stay; `preview`
 *  is the captured line holding the secret. */
function maskLootMatches(value: unknown, marker: string): unknown {
  if (!Array.isArray(value)) return maskWhole(value, marker)
  let changed = false
  const out: unknown[] = []
  for (const match of value as unknown[]) {
    if (!match || typeof match !== 'object' || Array.isArray(match)) return marker
    const m = match as Record<string, unknown>
    if ('preview' in m && m.preview !== '') { out.push({ ...m, preview: marker }); changed = true } else out.push(m)
  }
  return changed ? out : KEEP
}

/** mitmproxy error classes that carry no server bytes. An error that is one
 *  of them stays; one that begins with one and a colon keeps the class and
 *  loses the rest (`Bad HTTP response line: b'…'`); anything else is the
 *  marker, since mitmproxy quotes what the server sent. */
const ERROR_CLASSES = new Set(['Connection killed', 'Client disconnected', 'Server disconnected', 'Connection closed', 'unknown', 'error',
  'Bad HTTP response line', 'Bad HTTP request line', 'Invalid header line', 'unexpected server response', 'TLS handshake failed',
  'Certificate verify failed', 'HTTP/2 protocol error'])

function maskErrorText(value: unknown, marker: string): unknown {
  if (typeof value !== 'string') return maskWhole(value, marker)
  const trimmed = value.trim()
  if (ERROR_CLASSES.has(trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed)) return KEEP
  const colon = trimmed.indexOf(':')
  const head = colon > 0 ? trimmed.slice(0, colon).trim() : ''
  return head && ERROR_CLASSES.has(head) ? `${head}: ${marker}` : marker
}

/** A scope_violation's `action` (alert/scope-signal.ts): `METHOD url` for
 *  HTTP, `WS|TCP direction url-or-host` for the scanner, `TYPE name` for DNS —
 *  the URL is masked, the rest stays. For a shell command or an agent tool it
 *  is command text and stays (see the header), unless an agent tool's input is
 *  itself a URL. */
function maskViolationAction(value: unknown, marker: string, data: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return maskWhole(value, marker)
  let masked = value
  if (data.source === 'http') {
    const space = value.indexOf(' ')
    masked = space < 0 ? maskUrlText(value, marker) : `${value.slice(0, space + 1)}${maskUrlText(value.slice(space + 1), marker)}`
  } else if (data.source === 'scanner') {
    masked = maskUrlsInText(value, marker)
  } else if (data.source === 'agent_tool') {
    const space = value.indexOf(' ')
    const input = space < 0 ? '' : value.slice(space + 1)
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) masked = `${value.slice(0, space + 1)}${maskUrlText(input, marker)}`
  } else if (data.source !== 'shell' && data.source !== 'dns') {
    masked = marker
  }
  return masked === value ? KEEP : masked
}

/** Browser rows from the CDP connector (src/main/services/cdp-connector.ts). */
const BROWSER_CONSOLE_SUBTYPES = new Set(['console_log', 'console_info', 'console_warn', 'console_error', 'console_debug', 'console_trace', 'exception', 'log_entry'])

/** A masker that applies only to rows of the given subtypes; others keep the
 *  field, because the same key means something else on them (a shell row's
 *  `source` names its terminal, a note's `title` is the operator's own). */
function forSubtypes(subtypes: ReadonlySet<string>, masker: FieldMasker): FieldMasker {
  // `has` on anything that is not one of the names is false, so a row whose
  // subtype is missing or not a string keeps the field.
  return (value, marker, data) => subtypes.has(data.subtype as string) ? masker(value, marker, data) : KEEP
}

const NAVIGATION = new Set(['navigation'])
/** The addon's HTTP rows. `path` is gated to them: on a file row it is a file
 *  path, where `#` or `;` is part of the name. */
const HTTP_SUBTYPES = new Set(['http_request_start', 'http_response', 'http_error', 'http_request_dropped', 'http_response_chunk', 'ws_message', 'websocket_end'])

/** A navigation's description is `→ host`, or the start of the URL when the
 *  connector found no host. Any other row's description is RedLog's own
 *  sentence, with the URLs in it masked (`↓ curl: https://…`). */
function maskDescription(value: unknown, marker: string, data: Record<string, unknown>): unknown {
  if (!NAVIGATION.has(data.subtype as string)) return maskTextUrls(value, marker)
  if (typeof value !== 'string') return maskWhole(value, marker)
  if (value === `→ ${String(data.host ?? '')}`) return KEEP
  const masked = value.startsWith('→ ') ? `→ ${maskUrlText(value.slice(2), marker)}` : marker
  return masked === value ? KEEP : masked
}

/** Every field scope masking rewrites, and how. A field not listed here is
 *  exported as recorded — see the header for what that leaves. */
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
  error: forSubtypes(new Set(['http_error', 'tcp_end']), maskErrorText),
  // cookie_change: truncated hashes of a session cookie's old and new value.
  old_hash: forSubtypes(new Set(['cookie_change']), maskWhole),
  new_hash: forSubtypes(new Set(['cookie_change']), maskWhole),
  matches: forSubtypes(new Set(['credential_detected']), maskLootMatches),
  action: forSubtypes(new Set(['scope_violation']), maskViolationAction),
  title: forSubtypes(NAVIGATION, maskWhole),
  description: maskDescription,
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
 * Replacement values for the masked fields of an out-of-scope or unclassified
 * event, or null when the event is in scope / carries nothing to mask. Each
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
