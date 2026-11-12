// What the loopback API accepts as a request, decided before any handler acts.
//
// Kept apart from api-server.ts so the shapes can be tested without binding a
// port. Each function answers "usable" or a fixed message for a 400; none of
// them throws, and none of them echoes what it was given back to the caller.

/** Nesting a JSON body may have. Every event, marker and bookmark the app
 *  writes is a few levels deep; the redaction and ingest walks recurse, so a
 *  body nested thousands of levels overflowed the stack inside a handler. */
export const MAX_JSON_DEPTH = 64

/** Whether `text` opens more than `max` arrays/objects inside one another.
 *  A linear scan of the raw text, before JSON.parse and before anything walks
 *  the result recursively — so it cannot itself overflow. */
export function jsonDepthExceeds(text: string, max: number = MAX_JSON_DEPTH): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (c === 0x5c) i++ // backslash: skip the escaped character
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b || c === 0x5b) { if (++depth > max) return true }
    else if (c === 0x7d || c === 0x5d) depth--
  }
  return false
}

export type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string }

export const BODY_INVALID = 'invalid or empty JSON body'
export const BODY_TOO_DEEP = 'JSON body is nested too deeply'
export const BODY_NOT_OBJECT = 'JSON body must be an object'

/** The body of a JSON route: a plain object, or a reason for a 400. `null`,
 *  arrays, strings and numbers are valid JSON and were taken for an event, a
 *  marker or a bookmark — or threw a TypeError that went back as a 500. */
export function parseJsonObjectBody(raw: string): BodyResult {
  if (jsonDepthExceeds(raw)) return { ok: false, error: BODY_TOO_DEEP }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ok: false, error: BODY_INVALID } }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: BODY_NOT_OBJECT }
  return { ok: true, body: parsed as Record<string, unknown> }
}

export type RecordingAction = 'pause' | 'resume' | 'toggle'

/** `POST /api/recording` changes capture for the whole project, so it acts only
 *  on an action it was named. A missing or unknown one is a 400 and changes
 *  nothing: a broken integration must not pause recording by accident. */
export function parseRecordingAction(body: Record<string, unknown>): RecordingAction | null {
  const action = body.action
  return action === 'pause' || action === 'resume' || action === 'toggle' ? action : null
}

export type IntParam = { ok: true; value: number | undefined } | { ok: false; error: string }

const DIGITS = /^\d+$/

/** A row count from the query string: absent → `fallback`; a positive integer
 *  → itself, clamped to `max`; anything else (0, negative, fractional, text)
 *  → a 400. SQLite reads `LIMIT -1` as "no limit", and these queries run on
 *  the main thread. */
export function parseLimitParam(raw: string | null, name: string, fallback: number, max: number): IntParam {
  if (raw === null || raw === '') return { ok: true, value: fallback }
  if (!DIGITS.test(raw)) return { ok: false, error: `${name} must be a positive integer` }
  const n = Number(raw)
  if (n <= 0) return { ok: false, error: `${name} must be a positive integer` }
  return { ok: true, value: Math.min(n, max) }
}

/** A timestamp bound (`since`, `before`): absent → undefined; a non-negative
 *  integer of milliseconds → itself; anything else → a 400 rather than NaN
 *  reaching the query. */
export function parseTimeParam(raw: string | null, name: string): IntParam {
  if (raw === null || raw === '') return { ok: true, value: undefined }
  const n = Number(raw)
  if (!DIGITS.test(raw) || !Number.isSafeInteger(n)) return { ok: false, error: `${name} must be a non-negative integer (ms)` }
  return { ok: true, value: n }
}

/** Longest `text` `POST /api/loot/scan` takes (docs/api-reference.md); longer
 *  is a 413. The scan runs on the main thread, and two built-in JWT shapes
 *  re-read a long unbroken token run from every `eyJ` in it — quadratic in
 *  the run. At this length that worst case measured 78 ms; at 32 Ki it was
 *  311 ms and at 128 Ki 5.2 s, freezing capture and the UI (#695). */
export const LOOT_SCAN_MAX_CHARS = 16 * 1024

/** Documented maxima for `limit` (docs/api-reference.md). */
export const API_LIMITS = {
  events: { fallback: 100, max: 1000 },
  search: { fallback: 100, max: 1000 },
  anchors: { fallback: 50, max: 1000 },
  har: { fallback: 50000, max: 50000 }
} as const
