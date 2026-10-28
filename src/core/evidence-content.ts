import { createHash } from 'node:crypto'
import { getReadonlyDB } from './db/index'
import { withVerifiedBody, ContentAccessError, type ByteSource } from './body-source'
import type { BodyRef } from './http-body-store'
import type { ContentField, ContentDescriptor, ContentRef, ContentReadRequest, ContentFindRequest, ContentWindow, ContentFindResult, ContentResult } from './content-contract'
const FIELDS: Array<{
  field: ContentField
  path: string
  ref?: string
  encoding?: string
}> = [
  { field: 'command', path: '$.command' }, { field: 'stdout', path: '$.stdout', ref: '$.stdout_ref' },
  { field: 'stderr', path: '$.stderr', ref: '$.stderr_ref' }, { field: 'full', path: '$.full' },
  { field: 'preview', path: '$.preview' }, { field: 'tool_input', path: '$.tool_input' }, { field: 'output', path: '$.output' },
  ...(['request_body', 'response_body', 'ws_body', 'tcp_body', 'output_body'] as const).map(field => ({ field, path: `$.${field}.data`, ref: `$.${field}_ref`, encoding: `$.${field}.encoding` }))
]
const WINDOW = 65536, SCAN = 1024 * 1024
function result<T>(read: () => T): ContentResult<T> {
  try {
    return { ok: true, value: read() }
  }
  catch (error) {
    return { ok: false, status: error instanceof ContentAccessError ? error.status : 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
function owner(projectId: string, eventId: string) {
  if (typeof projectId !== 'string' || !projectId || typeof eventId !== 'string' || !eventId)
    throw new ContentAccessError('denied', 'Content requires a project and Event')
  const db = getReadonlyDB()
  const rows = db.prepare(`SELECT rowid AS rowid,'events' AS tab,agent_type,subtype FROM events WHERE id=? AND engagement_id=?
  UNION ALL SELECT rowid,'events_logged' AS tab,agent_type,subtype FROM events_logged WHERE id=? AND engagement_id=?`).all(eventId, projectId, eventId, projectId) as Array<{
    rowid: number
    tab: string
    agent_type: string
    subtype: string
  }>
  if (rows.length !== 1)
    throw new ContentAccessError('denied', 'Content Event is unavailable in this project')
  return { db, ...rows[0] }
}
type Owner = ReturnType<typeof owner>
function probe(o: Owner, field: typeof FIELDS[number]) {
  return o.db.prepare(`SELECT json_type(data,?) AS kind,length(CAST(json_extract(data,?) AS BLOB)) AS bytes,
  json_extract(data,?) AS ref,json_extract(data,?) AS encoding,
  COALESCE(json_extract(data,?),json_extract(data,?)) AS truncated FROM ${o.tab} WHERE rowid=?`).get(field.path, field.path, field.ref ?? '$.nonexistent_content_ref', field.encoding ?? '$.nonexistent_encoding', `$.${field.field}_truncated`, `$.${field.field}.truncated`, o.rowid) as {
    kind: string | null
    bytes: number | null
    ref: string | null
    encoding: string | null
    truncated: number | null
  }
}
function withSource<T>(o: Owner, field: typeof FIELDS[number], use: (source: ByteSource, partial: boolean) => T): T {
  const p = probe(o, field)
  if (p.ref) {
    const ref = JSON.parse(p.ref) as BodyRef
    return withVerifiedBody(ref, source => use(source, ref.truncated === true || p.truncated === 1))
  }
  if (!p.kind || p.kind === 'null')
    throw new ContentAccessError('not-captured', 'This content was not captured')
  const literal = p.kind === 'true' || p.kind === 'false' ? Buffer.from(p.kind) : null
  const size = literal?.length ?? p.bytes ?? 0
  const read = (offset: number, length: number): Buffer => {
    if (length === 0)
      return Buffer.alloc(0)
    if (literal)
      return literal.subarray(offset, offset + length)
    const row = o.db.prepare(`SELECT substr(CAST(json_extract(data,?) AS BLOB),?,?) AS chunk FROM ${o.tab} WHERE rowid=?`).get(field.path, offset + 1, length, o.rowid) as {
      chunk: Buffer
    }
    return row.chunk
  }
  if (p.encoding === 'base64') {
    if (size > 16384)
      throw new ContentAccessError('unsupported', 'Large inline base64 must be stored as a body reference')
    const buf = Buffer.from(read(0, size).toString('utf8'), 'base64')
    let text = true
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf)
    }
    catch {
      text = false
    }
    if (buf.includes(0))
      text = false
    return use({ bytes: buf.length, digest: createHash('sha256').update(buf).digest('hex'), format: text ? 'utf8' : 'binary', read: (start, len) => buf.subarray(start, start + len) }, p.truncated === 1)
  }
  const hash = createHash('sha256')
  let text = true
  for (let off = 0; off < size; off += WINDOW) {
    const buf = read(off, Math.min(WINDOW, size - off))
    hash.update(buf)
    if (buf.includes(0))
      text = false
  }
  return use({ bytes: size, digest: hash.digest('hex'), format: !text ? 'binary' : ['object', 'array', 'true', 'false', 'integer', 'real'].includes(p.kind) ? 'json' : 'utf8', read }, p.truncated === 1 || field.field === 'preview')
}
function refOf(projectId: string, eventId: string, field: ContentField, source: ByteSource): ContentRef {
  const version = 'content1:' + createHash('sha256').update(JSON.stringify([projectId, eventId, field, source.digest, source.bytes, source.format])).digest('hex')
  return { projectId, eventId, field, version }
}
export function describeEventContent(projectId: string, eventId: string): ContentResult<ContentDescriptor[]> {
  return result(() => {
    const o = owner(projectId, eventId), descriptors: ContentDescriptor[] = []
    for (const field of FIELDS) {
      const p = probe(o, field)
      if (!p.kind && !p.ref && !(o.agent_type === 'shell' && o.subtype === 'command_end' && ['stdout', 'stderr'].includes(field.field)))
        continue
      const found = result(() => withSource(o, field, (source, partial) => ({ field: field.field, status: 'available' as const, ref: refOf(projectId, eventId, field.field, source), bytes: source.bytes, format: source.format, capture: partial ? 'partial' as const : 'unknown' as const })))
      descriptors.push(found.ok ? found.value : { field: field.field, status: found.status, ref: null, bytes: 0, format: 'utf8', capture: 'unknown' })
    }
    return descriptors
  })
}
function access<T>(ref: ContentRef, use: (source: ByteSource) => T): ContentResult<T> {
  return result(() => {
    const field = FIELDS.find(f => f.field === ref?.field)
    if (!field || typeof ref.version !== 'string')
      throw new ContentAccessError('denied', 'Unknown content field')
    return withSource(owner(ref.projectId, ref.eventId), field, source => {
      if (refOf(ref.projectId, ref.eventId, ref.field, source).version !== ref.version)
        throw new ContentAccessError('changed', 'Content version changed; reopen the source')
      return use(source)
    })
  })
}
function position(ref: ContentRef, cursor: {
  version: string
  offset: number
} | undefined, offset = 0): number {
  if (cursor && cursor.version !== ref.version)
    throw new ContentAccessError('changed', 'Content cursor belongs to another version')
  const n = cursor?.offset ?? offset
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ContentAccessError('failed', 'Invalid content offset')
  return n
}
export function readEventContent(request: ContentReadRequest): ContentResult<ContentWindow> {
  return access(request.ref, source => {
    const offset = position(request.ref, request.cursor, request.offset), limit = request.limit ?? WINDOW
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > WINDOW || offset > source.bytes || request.cursor && request.offset != null)
      throw new ContentAccessError('failed', 'Invalid content window')
    let start = offset, end = Math.min(source.bytes, offset + limit), buf: Buffer
    if (source.format === 'binary')
      buf = source.read(start, end - start)
    else {
      const base = Math.max(0, offset - 3), raw = source.read(base, Math.min(source.bytes - base, limit + 6))
      let a = offset - base, b = Math.min(raw.length, offset - base + limit)
      while (a > 0 && (raw[a] & 0xc0) === 0x80)
        a--
      while (b > a && b < raw.length && (raw[b] & 0xc0) === 0x80)
        b--
      start = base + a
      end = base + b
      buf = raw.subarray(a, b)
    }
    return { offset: start, end, total: source.bytes, text: buf.toString(source.format === 'binary' ? 'base64' : 'utf8'), format: source.format, hasMore: end < source.bytes, nextCursor: end < source.bytes ? { version: request.ref.version, offset: end } : null }
  })
}
export function findEventContent(request: ContentFindRequest): ContentResult<ContentFindResult> {
  return access(request.ref, source => {
    if (source.format === 'binary')
      throw new ContentAccessError('unsupported', 'Binary content does not support text search')
    const needle = Buffer.from(request.needle, 'utf8'), offset = position(request.ref, request.cursor)
    if (!needle.length || needle.length > 4096 || offset > source.bytes)
      throw new ContentAccessError('failed', 'Invalid content search')
    const query = createHash('sha256').update(needle).digest('hex')
    if (request.cursor && request.cursor.query !== query)
      throw new ContentAccessError('changed', 'Content search cursor belongs to another query')
    const through = Math.min(source.bytes, offset + SCAN)
    for (let off = offset; off < through; off += WINDOW) {
      const span = Math.min(WINDOW, through - off), buf = source.read(off, Math.min(source.bytes - off, span + needle.length - 1)), index = buf.indexOf(needle)
      if (index >= 0 && index < span) {
        const next = off + index + needle.length
        return { match: { offset: off + index, bytes: needle.length }, searchedThrough: next, total: source.bytes, hasMore: next < source.bytes, nextCursor: next < source.bytes ? { version: request.ref.version, offset: next, query } : null }
      }
    }
    return { match: null, searchedThrough: through, total: source.bytes, hasMore: through < source.bytes, nextCursor: through < source.bytes ? { version: request.ref.version, offset: through, query } : null }
  })
}

/** Clipboard transfer is bounded; larger versions remain available as files. */
export function readContentForClipboard(ref: ContentRef): ContentResult<{text:string;bytes:number}> {
  return access(ref,source=>{
    if(source.format==='binary')throw new ContentAccessError('unsupported','Binary content is available as a file')
    if(source.bytes>1024*1024)throw new ContentAccessError('unsupported','clipboard-limit')
    return {text:new TextDecoder('utf-8',{fatal:true}).decode(source.read(0,source.bytes)),bytes:source.bytes}
  })
}

/** Validate and hash a small exact byte range; never persist raw excerpts by default. */
export function createContentAnchor(request: import('./content-contract').ContentAnchorRequest): ContentResult<import('./content-contract').ContentAnchor> {
  return access(request?.ref, source=>{
    const {start,end}=request
    if(source.format==='binary')throw new ContentAccessError('unsupported','Binary selection has no text coordinate map')
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>source.bytes||end-start>16384)throw new ContentAccessError('failed','Selection must be an exact range of at most 16 KiB')
    const bytes=source.read(start,end-start)
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new ContentAccessError('unsupported','Selection splits a UTF-8 codepoint')}
    const {projectId,eventId,field,version}=request.ref
    return {v:1,coordinate:'utf8-bytes',ref:{projectId,eventId,field,version},start,end,sha256:createHash('sha256').update(bytes).digest('hex')}
  })
}

export function resolveContentAnchor(anchor: import('./content-contract').ContentAnchor): ContentResult<{text:string;offset:number}> {
  if(anchor?.v!==1||anchor.coordinate!=='utf8-bytes'||typeof anchor.sha256!=='string')return {ok:false,status:'unsupported',message:'Unsupported evidence coordinate'}
  const verified=createContentAnchor(anchor)
  if(!verified.ok)return verified
  if(verified.value.sha256!==anchor.sha256)return {ok:false,status:'changed',message:'Evidence fragment digest does not match'}
  return access(anchor.ref,source=>({text:new TextDecoder('utf-8',{fatal:true}).decode(source.read(anchor.start,anchor.end-anchor.start)),offset:anchor.start}))
}
