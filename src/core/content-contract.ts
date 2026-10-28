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
