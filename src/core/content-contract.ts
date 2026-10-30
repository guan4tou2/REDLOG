export type ContentField = 'command' | 'stdout' | 'stderr' | 'full' | 'preview' | 'tool_input' | 'output' | 'request_body' | 'response_body' | 'ws_body' | 'tcp_body' | 'output_body' | 'artifact' | 'ai_raw'
export type ContentUnavailable = 'not-captured' | 'missing' | 'changed' | 'denied' | 'unsupported' | 'failed'
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

/** Shared partial-index predicate: evidence rows without saved content stay off reader scans. */
export const BODY_SOURCE_PREDICATE = `CASE WHEN json_valid(data) THEN (${[
  ...BODY_REF_FIELDS.map(field => `json_extract(data,'$.${field}.sha256') IS NOT NULL`),
  ...BODY_REF_FIELDS.filter(field => field.endsWith('_body_ref')).map(field => `json_extract(data,'$.${field.slice(0, -4)}.encoding')='base64'`),
  "(agent_type='file_transfer' AND subtype='artifact_added')",
  "(agent_type='agent' AND subtype IN ('transcript_snapshot','transcript_capture_started'))"
].join(' OR ')}) ELSE 0 END`
