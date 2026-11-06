export type ContentField = 'command' | 'stdout' | 'stderr' | 'full' | 'preview' | 'tool_input' | 'output' | 'request_body' | 'response_body' | 'ws_body' | 'tcp_body' | 'output_body' | 'artifact' | 'ai_raw'
export type ContentUnavailable = 'not-captured' | 'missing' | 'changed' | 'denied' | 'unsupported' | 'failed' | 'cast-recording'
export interface ContentRef {
  projectId: string
  eventId: string
  field: ContentField
  version: string
}
export interface ContentDescriptor {
  field: ContentField
  status: 'available' | ContentUnavailable
  ref: ContentRef | null
  bytes: number
  format: 'utf8' | 'json' | 'binary'
  capture: 'partial' | 'unknown'
}
export interface ContentCursor {
  version: string
  offset: number
}
export interface ContentReadRequest {
  ref: ContentRef
  offset?: number
  cursor?: ContentCursor
  limit?: number
}
export interface ContentWindow {
  offset: number
  end: number
  total: number
  text: string
  format: ContentDescriptor['format']
  hasMore: boolean
  nextCursor: ContentCursor | null
}
export interface ContentFindCursor extends ContentCursor {
  query: string
}
export interface ContentFindRequest {
  ref: ContentRef
  needle: string
  cursor?: ContentFindCursor
}
export interface ContentFindResult {
  match: {
    offset: number
    bytes: number
  } | null
  searchedThrough: number
  total: number
  hasMore: boolean
  nextCursor: ContentFindCursor | null
}
export type ContentResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  status: ContentUnavailable
  message: string
}

export interface ContentAnchorRequest {
  ref: ContentRef
  start: number
  end: number
}
export interface ContentAnchor extends ContentAnchorRequest {
  v: 1
  coordinate: 'utf8-bytes'
  sha256: string
}

/** Pure reference vocabulary shared by readers, retention, export and UI. */
export const BODY_REF_FIELDS = [
  'request_body_ref', 'response_body_ref', 'ws_body_ref', 'tcp_body_ref',
  'stdout_ref', 'stderr_ref', 'output_body_ref'
] as const

/** Capture loss is independent of how many bytes a reader has paged in. */
export function capturedContentIsPartial(data: Record<string, unknown>): boolean {
  if ((typeof data.stream_not_queued_bytes === 'number' && data.stream_not_queued_bytes > 0) || data.stream_state === 'interrupted') return true
  if (data.truncated === true || data.stdout_truncated === true || data.stderr_truncated === true
    || (data.io as { truncated?: boolean } | undefined)?.truncated === true) return true
  return BODY_REF_FIELDS.some(field => (data[field] as { truncated?: boolean } | undefined)?.truncated === true)
}

/** A body the producer cut short: the bytes that were stored and, only when
 *  the producer reported it, the size it saw (#290). Null for a body that was
 *  not cut. An unknown total is null, never the stored size. */
export function bodyTruncation(
  inline: { data?: string; encoding?: string; size?: number; truncated?: boolean } | undefined,
  ref: { size: number; truncated?: boolean; totalSize?: number } | undefined
): { saved: number; total: number | null } | null {
  if (ref?.truncated) return { saved: ref.size, total: typeof ref.totalSize === 'number' && ref.totalSize > ref.size ? ref.totalSize : null }
  if (!inline?.truncated || typeof inline.data !== 'string') return null
  const saved = inline.encoding === 'base64'
    ? Math.floor(inline.data.length * 3 / 4) - (inline.data.endsWith('==') ? 2 : inline.data.endsWith('=') ? 1 : 0)
    : new TextEncoder().encode(inline.data).length
  return { saved, total: typeof inline.size === 'number' && inline.size > saved ? inline.size : null }
}

/** Shared partial-index predicate: evidence rows without saved content stay off reader scans. */
export const BODY_SOURCE_PREDICATE = `CASE WHEN json_valid(data) THEN (${[
  ...BODY_REF_FIELDS.map(field => `json_extract(data,'$.${field}.sha256') IS NOT NULL`),
  ...BODY_REF_FIELDS.filter(field => field.endsWith('_body_ref')).map(field => `json_extract(data,'$.${field.slice(0, -4)}.encoding')='base64'`),
  "(agent_type='file_transfer' AND subtype='artifact_added')",
  "(agent_type='agent' AND subtype IN ('transcript_snapshot','transcript_capture_started'))"
].join(' OR ')}) ELSE 0 END`

/** What became of a finished shell command's output. Every reader names these
 *  five (plus the inline text itself) the same way, because every reader asks
 *  this function instead of working it out from `stdout`/`io`/`*_ref` itself
 *  (#591): the Timeline said "nothing recorded" for a command that printed
 *  nothing while the transcript called it "not captured".
 *
 *  - `inline`       text is on the event (even if cut at the cap)
 *  - `saved`        stored beside the event by reference; the content reader opens it
 *  - `recorded`     a bracketed span of the session recording holds it
 *  - `empty`        a bracketed span says the command printed nothing
 *  - `unbracketed`  built-in terminal, but no span could be matched to it
 *  - `not-captured` an external shell: the command only, no output */
export type CommandOutputState = 'inline' | 'saved' | 'recorded' | 'empty' | 'unbracketed' | 'not-captured'

export function commandOutputState(data: Record<string, unknown>, hasInlineText = false): CommandOutputState {
  const inline = (text: unknown, bytes: unknown, truncated: unknown): boolean =>
    typeof text === 'string' && (text.length > 0 || Number(bytes) > 0 || truncated === true)
  if (hasInlineText || inline(data.stdout, data.stdout_bytes, data.stdout_truncated)
    || inline(data.stderr, data.stderr_bytes, data.stderr_truncated)) return 'inline'
  if (data.stdout_ref || data.stderr_ref) return 'saved'
  const io = data.io as { len?: unknown; unbracketed?: unknown } | undefined
  if (typeof io?.len === 'number' && !io.unbracketed) return io.len > 0 ? 'recorded' : 'empty'
  return data.source === 'builtin-terminal' ? 'unbracketed' : 'not-captured'
}

/** The same question for an HTTP response body, as the transcript asks it:
 *  a preview on the event is `inline`, a stored body (inline object or ref) is
 *  `saved` and opens in the HTTP detail, a declared length of 0 is `empty`, and
 *  only the rest is `not-captured`. */
export type ResponseBodyState = 'inline' | 'saved' | 'empty' | 'not-captured'

export function responseBodyState(data: Record<string, unknown>): ResponseBodyState {
  if (typeof data.response_preview === 'string' && data.response_preview.length > 0) return 'inline'
  if (data.response_body_ref || data.response_body) return 'saved'
  return data.content_length === 0 ? 'empty' : 'not-captured'
}
