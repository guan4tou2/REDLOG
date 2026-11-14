import { BODY_SOURCE_PREDICATE, ESCAPE_DECODED_BODY_FIELDS } from './content-contract'
import { decodeJsonEscapes, jsonEscapeDecoder } from './json-escape-text'
import Database from 'better-sqlite3'
import fs, { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDB, getProjectDir } from './db/index'
import type { RedLogEvent } from './db/events'
import type { ExportSnapshot } from './export-plan'
import type { EventFilter } from './db/event-queries'
import type { ParsedQuery } from './query/contract'
import { toFtsMatch, ftsTerms } from './query/fts-match'
import { BODY_REF_FIELDS, type BodyRef } from './http-body-store'
import { withVerifiedBody, withVerifiedSavedFile, savedFileRefs, withInlineBase64, ContentAccessError, type ByteSource, type SavedFileRef } from './body-source'
const INDEX_CHUNK_BYTES = 1024 * 1024
const INDEX_OVERLAP_CHARS = 65536
const INDEX_VERSION = 9
let index: Database.Database | null = null, indexDir: string | null = null
function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir)
    return index
  closeHttpBodyIndex()
  const db = index = new Database(path.join(projectDir, 'http-body-index.db'))
  db.pragma('journal_mode = WAL')
  // `synchronous` stays at the WAL default (NORMAL), unlike timeline.db: a
  // row lost to an OS crash here is linked again by the first search after
  // launch, which walks every content-ref event (see the backfill note below).
  // Rebuild only this disposable index, never a source Event or sidecar.
  // v7 added the verification columns below; v9 adds the decoded text of
  // JSON escapes and of bodies in a declared charset, body_docs, and what
  // coverage needs per ref (engagement, source row, order, source bytes), so
  // coverage reads this table instead of re-deriving every row's refs.
  // An older index is rebuilt once, from the source rows, at the next search.
  // The schema is written in one transaction, and an index already current is
  // opened without a write: each commit is a flush, slow on Windows.
  if (db.pragma('user_version', { simple: true }) !== INDEX_VERSION) db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_docs; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state; DROP TABLE IF EXISTS body_index_meta')
    // FTS5 finds a row only by MATCH or rowid. body_docs maps each document to
    // its (event, body) pair through a real index, so removing one ref's text
    // never reads every document.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
    CREATE TABLE IF NOT EXISTS body_docs (doc INTEGER PRIMARY KEY,event_id TEXT NOT NULL,sha256 TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS body_docs_ref ON body_docs(event_id,sha256);
    CREATE INDEX IF NOT EXISTS body_docs_sha256 ON body_docs(sha256);
    CREATE TABLE IF NOT EXISTS body_event_refs (
     event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
     status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,
     tier TEXT,verified_desc TEXT,verified_file TEXT,verified_sig TEXT,
     engagement_id TEXT,row INTEGER,pos INTEGER NOT NULL,source_bytes INTEGER NOT NULL,PRIMARY KEY(event_id,sha256)
    );
    CREATE INDEX IF NOT EXISTS body_event_refs_sha256 ON body_event_refs(sha256);
    CREATE TABLE IF NOT EXISTS body_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    db.pragma(`user_version=${INDEX_VERSION}`)
  })()
  db.exec('CREATE TEMP TABLE body_seen(event_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(event_id,sha256));')
  indexDir = projectDir
  return index
}
export function closeHttpBodyIndex(): void { if (index) {
  try {
    index.close()
  }
  catch { }
} index = null; indexDir = null; resetSyncState() }

// ── Incremental backfill state (#695) ─────────────────────────────────────
// Verify once, then trust until the file changes. A ref linked with a final,
// content-derived status is stored with the lstat signature its file had
// when it was verified (the same dev:ino:size:mtime:ctime signature
// body-source uses for its own cache) in its own body_event_refs row:
// `verified_desc` (what the event said about the ref), `verified_file` and
// `verified_sig`. A later link of that ref whose event data is unchanged and
// whose file still has that signature skips the open and the hash. Missing and
// failed refs carry no verification (`verified_desc` NULL): they are retried on
// every search, as before.
//
// The verification is persisted, in the same transaction as the row it
// describes, so it survives a restart and a rolled-back write takes it back
// with the row. Only the walk watermark below lives in memory: the first
// search after launch (or a project switch) walks every content-ref row again,
// which reads rows and lstats files but opens and hashes only what changed.
//
// The relaxation: a search does not notice a saved file whose bytes were
// changed in place without changing its dev, inode, size, mtime or ctime, and
// because the signature is persisted that now holds across restarts too: a file
// rewritten that way while the app is closed is never noticed by search
// (previously it was re-verified at the next launch). It needs a clock or
// filesystem forged under it. Reading a body for display still verifies it
// every time.
type Tier = 'events' | 'events_logged'
const TIERS = ['events', 'events_logged'] as const
/** Events linked outside a walk (ingest) since the last walk. */
let linkedOutsideWalk = new Set<string>()
/** What the last walk covered; null means "walk everything next time". */
let walked: { source: Database.Database; boundary: string; latest: string; tiers: Array<{ n: number; max: number; idAtMax: string | null }> } | null = null
let dirty = true
let statements = new Map<string, Database.Statement>()
function resetSyncState(): void {
  linkedOutsideWalk = new Set(); walked = null; dirty = true; statements = new Map()
}
/** A rolled-back transaction leaves the watermark describing rows that were
 *  never committed; walk everything next time. */
function forgetOnError(run: () => void): void {
  try { run() } catch (error) { walked = null; dirty = true; throw error }
}
// Prepared once per index handle, lazily, so a statement is compiled the first
// time a path needs it.
function stmt(db: Database.Database, sql: string): Database.Statement {
  let s = statements.get(sql)
  if (!s) { s = db.prepare(sql); statements.set(sql, s) }
  return s
}
const FINAL_STATUSES = new Set(['indexed', 'partial', 'binary', 'limited', 'pending'])
/** The statuses whose ref has FTS documents. */
const HAS_DOCS = new Set(['indexed', 'partial'])
/** Remove one ref's documents through body_docs: O(its documents). */
function dropDocs(db: Database.Database, eventId: string, sha256: string): void {
  const docs = stmt(db, 'SELECT doc FROM body_docs WHERE event_id=? AND sha256=?').all(eventId, sha256) as { doc: number }[]
  if (!docs.length) return
  const drop = stmt(db, 'DELETE FROM body_fts WHERE rowid=?')
  for (const { doc } of docs) drop.run(doc)
  stmt(db, 'DELETE FROM body_docs WHERE event_id=? AND sha256=?').run(eventId, sha256)
}
// Inline bodies whose escapes were scanned and hashed by refsOf; a test seam
// for "a search does no per-row work for rows already linked".
let inlineRefWork = 0
export function _inlineRefWork(): number { return inlineRefWork }
function fileSignature(file: string): string {
  try {
    const s = fs.lstatSync(file, { bigint: true })
    return [s.isFile() ? 'f' : 'x', s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
  } catch (error) { return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }
}
/** The containing directories: replacing one (or swapping it for a link)
 *  invalidates every remembered verification. */
function directorySignature(projectDir: string): string {
  return ['http-bodies', 'artifacts', 'agent-transcripts'].map(name => {
    try {
      const s = fs.lstatSync(path.join(projectDir, name), { bigint: true })
      return [s.isDirectory() && !s.isSymbolicLink() ? 'd' : 'x', s.dev, s.ino].join(':')
    } catch { return 'none' }
  }).join('|')
}
function refFile(ref: IndexedRef, projectDir: string): string | null {
  if (ref.kind === 'body') return ref.inline !== undefined ? null : path.join(projectDir, 'http-bodies', ref.file)
  return ref.pending ? null : path.resolve(projectDir, ref.file)
}
/** `decode`: also index the text with JSON escapes decoded. `charset`: how to
 *  read bytes that are not valid UTF-8 (textCharset). `inline`: the body is on
 *  the event itself, as its `encoding` says. `truncated` / `totalSize`: the
 *  capture cut it short, and the size it saw when it said. */
type BodyIndexRef = BodyRef & {kind:'body';inline?:string;decode:boolean;charset?:string}
type IndexedRef = BodyIndexRef | (SavedFileRef & {kind:'artifact'|'ai-raw';encoding:'text'})
// Resolve after module initialization: artifact -> events -> body-store is a cycle.
function inlineBodyFields():string[]{return BODY_REF_FIELDS.filter(field=>field.endsWith('_body_ref')).map(field=>field.slice(0,-4))}
const decodesEscapes = (field: string): boolean => (ESCAPE_DECODED_BODY_FIELDS as readonly string[]).includes(field)
function headerValue(headers: unknown, name: string): string | undefined {
  if (Array.isArray(headers)) {
    const pair = headers.find(h => Array.isArray(h) && typeof h[0] === 'string' && h[0].toLowerCase() === name && typeof h[1] === 'string') as [string, string] | undefined
    return pair?.[1]
  }
  if (headers && typeof headers === 'object')
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name && typeof value === 'string') return value
  return undefined
}
// The media types the capture addon treats as text (TEXT_CONTENT_TYPES in
// hooks/mitmproxy-addon.py, matched the same way: a substring of the type).
const TEXT_MEDIA_TOKENS = ['json', 'html', 'text', 'xml', 'javascript', 'css', 'csv', 'yaml', 'yml', 'svg', 'urlencoded', 'form-data']
/** How to read a body whose bytes are not valid UTF-8 as saved: the charset
 *  its content type declares (UTF-8 when it declares none), as TextDecoder
 *  names it — only for a textual media type. Undefined, and the body stays
 *  binary, for any other type, a missing type, or a charset this runtime
 *  cannot decode: the label is the target's to choose. */
function textCharset(contentType: unknown): string | undefined {
  if (typeof contentType !== 'string' || contentType.length > 1024) return undefined
  const [media, ...params] = contentType.split(';')
  const type = media.trim().toLowerCase()
  if (!TEXT_MEDIA_TOKENS.some(token => type.includes(token))) return undefined
  for (const param of params) {
    const eq = param.indexOf('=')
    if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== 'charset') continue
    const label = param.slice(eq + 1).trim().replace(/^"|"$/g, '')
    try { return new TextDecoder(label).encoding } catch { return undefined }
  }
  return 'utf-8'
}
/** Where the event says what a body's content type is: the inline envelope,
 *  else the request headers or the response's content type. */
function charsetOf(data: Record<string, unknown>, field: string): string | undefined {
  const envelope = (data[field] as { content_type?: unknown } | undefined)?.content_type
  if (typeof envelope === 'string') return textCharset(envelope)
  if (field === 'request_body') return textCharset(headerValue(data.request_headers, 'content-type'))
  if (field === 'response_body') return textCharset(typeof data.content_type === 'string' ? data.content_type : headerValue(data.response_headers, 'content-type'))
  return undefined
}
/** `atIngest`: leave out inline text bodies. Their decoded entry is written by
 *  the next walk, which reaches every new row anyway, so capture does not pay
 *  for a scan, a hash and a body-index commit per event. */
function refsOf(event: {agentType?:string;data:Record<string,unknown>}, atIngest = false): IndexedRef[] {
  return [
    ...BODY_REF_FIELDS.flatMap(field => {
      const value = event.data[field]
      const body = field.endsWith('_body_ref') ? field.slice(0, -4) : null
      const charset = body ? charsetOf(event.data, body) : undefined
      const ref = value as BodyRef
      return value && typeof value === 'object' && typeof ref.sha256 === 'string' && typeof ref.file === 'string'
        ? [{sha256:ref.sha256,file:ref.file,size:ref.size,
          encoding:ref.encoding,truncated:ref.truncated,...(typeof ref.totalSize === 'number' ? {totalSize:ref.totalSize} : {}),kind:'body' as const,
          decode:body !== null && decodesEscapes(body),...(charset ? {charset} : {})}] : []
    }),
    ...inlineBodyFields().flatMap((field):BodyIndexRef[]=>{
      const value=event.data[field] as {data?:unknown;encoding?:unknown;truncated?:unknown;size?:unknown}|undefined
      if(event.data[`${field}_ref`]||typeof value?.data!=='string')return []
      const decode=decodesEscapes(field)
      const cut=(stored:number)=>value.truncated===true?{truncated:true,...(typeof value.size==='number'&&value.size>stored?{totalSize:value.size}:{})}:{}
      if(value.encoding==='base64'){
        const charset=charsetOf(event.data,field), size=Buffer.byteLength(value.data,'base64')
        return [{kind:'body' as const,file:`inline:${field}`,sha256:createHash('sha256').update(value.data).digest('hex'),
          size,encoding:'base64' as const,inline:value.data,decode,...cut(size),...(charset ? {charset} : {})}]
      }
      // Inline text is in the events index already, as written. Only a body
      // with an escape to decode needs a body-index entry, and that entry
      // holds the decoded text alone.
      if(atIngest||!decode)return []
      inlineRefWork++
      if(decodeJsonEscapes(value.data)===null)return []
      const size=Buffer.byteLength(value.data,'utf8')
      return [{kind:'body' as const,file:`inline:${field}`,sha256:createHash('sha256').update(value.data).digest('hex'),
        size,encoding:'text' as const,inline:value.data,decode,...cut(size)}]
    }),
    ...savedFileRefs(event).map(ref=>({...ref,kind:ref.field==='artifact'?'artifact' as const:'ai-raw' as const,encoding:'text' as const}))
  ]
}
/** Bytes read in a declared charset that are not text after all: a NUL. */
class NotText extends Error {}
function withInlineText(text: string, use: (source: ByteSource) => void): void {
  const bytes = Buffer.from(text, 'utf8')
  use({ bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), format: 'utf8', read: (offset, length) => bytes.subarray(offset, offset + length) })
}
/** One FTS document stream: text in, rows of about INDEX_CHUNK_BYTES out,
 *  each cut at a tokenizer boundary and overlapping the one before. Call with
 *  `final` once, last. */
function ftsWriter(write: (part: string) => void): (part: string, final?: boolean) => void {
  let text = '', skippingToken = false
  const separator = /[^\p{L}\p{N}\p{Co}\p{M}]/u
  return (part, final = false) => {
    if(skippingToken) {
      const at=part.search(separator)
      if(at<0) return
      part=part.slice(at); skippingToken=false
    }
    text+=part
    if(final) { write(text); text=''; return }
    if(text.length<INDEX_CHUNK_BYTES) return
    let end=text.length-1
    while(end>=0 && !separator.test(text[end])) end--
    if(end<0) {
      // The FTS tokenizer itself caps a single token at 32768 bytes. Preserve
      // that prefix once; never turn a huge token's suffix into a hit.
      write(Buffer.from(text).subarray(0,32768).toString('utf8'))
      text=''; skippingToken=true; return
    }
    const complete=text.slice(0,end+1)
    write(complete)
    let start=complete.length>INDEX_OVERLAP_CHARS ? complete.length-INDEX_OVERLAP_CHARS : complete.length
    // Both ends of every overlapping document are tokenizer boundaries.
    while(start<complete.length && start>0 && !separator.test(complete[start-1])) start++
    text=complete.slice(start)+text.slice(end+1)
  }
}
export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data' | 'engagementId'> & {agentType?:string}, projectDir = getProjectDir()): void {
  getIndex(projectDir)
  linkedOutsideWalk.add(event.id)
  linkEvent(event, projectDir, null, { engagementId: event.engagementId ?? null, row: null }, true)
}
interface SourceRow { engagementId: string | null; row: number | null }
/** Link one event's refs; returns them, for the walk's record of what it saw. */
function linkEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir: string, tier: Tier | null, source: SourceRow, atIngest = false): IndexedRef[] {
  const db = getIndex(projectDir)
  const refs = refsOf(event, atIngest)
  // Inside a walk's transaction a savepoint per event buys nothing: any error
  // aborts the whole walk anyway.
  const atomic = (run: () => void): void => { if (db.inTransaction) run(); else forgetOnError(() => db.transaction(run)()) }
  if (refs.length) atomic(() => {
    for (const [pos, ref] of refs.entries()) {
      let status = 'indexed', bytes = 0, reason = '',availableBytes=0
      const prior = stmt(db, 'SELECT status,reason,tier,row,verified_desc,verified_file,verified_sig FROM body_event_refs WHERE event_id=? AND sha256=?').get(event.id, ref.sha256) as {
        status: string; reason: string; tier: Tier | null; row: number | null; verified_desc: string | null; verified_file: string | null; verified_sig: string | null
      } | undefined
      const file = refFile(ref, projectDir)
      const body = ref.kind === 'body' ? ref : null
      const desc = JSON.stringify([ref.file, ref.size, ref.encoding ?? null, ref.kind, ref.kind !== 'body' && ref.pending === true, body?.inline !== undefined,
        body?.decode ?? false, body?.charset ?? null, body?.truncated === true, body?.totalSize ?? null])
      // Nothing that decides this row has changed since it was verified.
      if (prior && prior.verified_desc === desc && FINAL_STATUSES.has(prior.status)
        && (prior.verified_file === null || (prior.verified_file === file && fileSignature(prior.verified_file) === prior.verified_sig))) {
        if (tier && (prior.tier !== tier || prior.row !== source.row))
          stmt(db, 'UPDATE body_event_refs SET tier=?,row=?,engagement_id=coalesce(?,engagement_id) WHERE event_id=? AND sha256=?').run(tier, source.row, source.engagementId, event.id, ref.sha256)
        continue
      }
      const hadDocs = prior !== undefined && HAS_DOCS.has(prior.status)
      // Taken before reading: a change while reading leaves a stale signature,
      // which only causes one more verification next time.
      const sig = file === null ? null : fileSignature(file)
      try {
        const read = (use: (source:ByteSource)=>void):void => {
          if(body?.inline!==undefined&&body.encoding==='text')withInlineText(body.inline,use)
          else if(body?.inline!==undefined)withInlineBase64(body.inline,use)
          else if(body) withVerifiedBody(body,use,projectDir)
          else withVerifiedSavedFile(ref as SavedFileRef,use,projectDir)
        }
        if(ref.kind!=='body'&&ref.pending)status='pending'
        else read(source => {
          availableBytes=source.availableBytes??source.bytes
          // Bytes that are not valid UTF-8 are text only in the charset a
          // textual content type declares (UTF-8 if none), and only as far
          // as every byte decodes in it.
          const charset = source.format !== 'binary' ? 'utf-8' : body?.charset
          if (!charset) { status = 'binary'; reason = 'binary'; return }
          const strict = source.format !== 'binary'
          bytes = source.bytes
          // Re-verified bytes with the same hash: the documents stand.
          if (prior && hadDocs) { status = prior.status; reason = prior.reason; return }
          const insertText = stmt(db, 'INSERT INTO body_fts(content) VALUES(?)'), insertDoc = stmt(db, 'INSERT INTO body_docs VALUES(?,?,?)')
          const write = (part: string): void => { if (part) insertDoc.run(insertText.run(part).lastInsertRowid, event.id, ref.sha256) }
          // The saved text, unless it is inline text the events index already
          // holds; and, in the same pass, once an escape has been seen, the
          // decoded text as a second document of the same (event, body) pair,
          // so it is pruned, verified and counted with the saved text. The
          // decoded document starts INDEX_OVERLAP_CHARS before the first
          // escape (at a token boundary): a term is one document's phrase,
          // and text further back is the saved document's, unchanged.
          const inlineText = body?.inline !== undefined && body.encoding === 'text'
          const saved = inlineText ? null : ftsWriter(write)
          const escapes = body?.decode ? jsonEscapeDecoder() : null
          let decoded: ReturnType<typeof ftsWriter> | null = null, lead = '', leadCut = false
          const startDecoded = (text: string, final: boolean): void => {
            decoded = ftsWriter(write)
            let start = leadCut ? lead.search(/[^\p{L}\p{N}\p{Co}\p{M}]/u) + 1 : 0
            if (start < 0) start = 0
            decoded(lead.slice(start) + text, final)
          }
          const each = (text: string): void => {
            if (!strict && text.includes('\0')) throw new NotText()
            saved?.(text)
            if (!escapes) return
            const out = escapes.push(text)
            if (decoded) decoded(out)
            else if (escapes.changed) startDecoded(out, false)
            else { lead += out; if (lead.length > INDEX_OVERLAP_CHARS) { lead = lead.slice(-INDEX_OVERLAP_CHARS); leadCut = true } }
          }
          const decoder = new TextDecoder(charset, { fatal: true })
          try {
            for (let off = 0; off < source.bytes; off += INDEX_CHUNK_BYTES)
              each(decoder.decode(source.read(off, Math.min(INDEX_CHUNK_BYTES, source.bytes - off)), {stream:true}))
            let tail = ''
            // A body cut mid-character (at the capture cap, say) decodes up to
            // the cut: index that, and say the body is only partly indexed.
            try { tail = decoder.decode() } catch (error) { if (strict || !(error instanceof TypeError)) throw error; status = 'partial'; reason = 'charset' }
            each(tail)
            saved?.('', true)
            if (escapes) {
              const out = escapes.end()
              if (decoded) (decoded as ReturnType<typeof ftsWriter>)(out, true)
              else if (escapes.changed) startDecoded(out, true)
            }
          } catch (error) {
            if (strict || !(error instanceof TypeError || error instanceof NotText)) throw error
            dropDocs(db, event.id, ref.sha256)
            bytes = 0; status = 'binary'; reason = 'binary'
          }
          if (status === 'indexed' && body?.truncated) { status = 'partial'; reason = 'truncated' }
        })
      }
      catch (error) {
        bytes = 0
        status = error instanceof ContentAccessError && error.status === 'missing' ? 'missing' : error instanceof ContentAccessError && error.status==='unsupported'?'limited':'failed'
        reason = error instanceof ContentAccessError ? error.status : 'failed'
      }
      // Only a ref that had documents can have any to remove.
      if (!HAS_DOCS.has(status) && hadDocs) dropDocs(db, event.id, ref.sha256)
      // pending/limited come from the event alone; indexed/binary/partial from
      // bytes whose signature is recorded. missing/failed can change with no
      // new row (a file restored or repaired), so they carry no verification
      // and are retried every search.
      const final = FINAL_STATUSES.has(status)
      const size = Number.isSafeInteger(ref.size) ? ref.size : 0
      const sourceBytes = sourceBytesOf(ref)
      stmt(db, `INSERT INTO body_event_refs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,sha256) DO UPDATE SET
    file=excluded.file,size=excluded.size,encoding=excluded.encoding,status=excluded.status,indexed_bytes=excluded.indexed_bytes,reason=excluded.reason,kind=excluded.kind,available_bytes=excluded.available_bytes,
    tier=coalesce(excluded.tier,body_event_refs.tier),verified_desc=excluded.verified_desc,verified_file=excluded.verified_file,verified_sig=excluded.verified_sig,
    engagement_id=coalesce(excluded.engagement_id,body_event_refs.engagement_id),row=coalesce(excluded.row,body_event_refs.row),pos=excluded.pos,source_bytes=excluded.source_bytes`).run(event.id, ref.sha256, ref.file, size, String(ref.encoding ?? 'unknown'), status, bytes, reason, ref.kind,availableBytes,
        tier, final ? desc : null, final && status !== 'pending' ? file : null, final && status !== 'pending' ? sig : null, source.engagementId, source.row, pos, sourceBytes)
    }
  })
  return refs
}
function latestSnapshotIds(snapshot?: ExportSnapshot): string[] {
  // A snapshot is a cumulative prefix of one saved file. Index the latest
  // confirmed version inside this dataset, rather than copying every prefix.
  return (getDB().prepare(`WITH versions AS (
    SELECT id,engagement_id,created_at,rowid AS r,1 AS tier,json_extract(data,'$.snapshot_path') AS file FROM events
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    UNION ALL SELECT id,engagement_id,created_at,rowid,0,json_extract(data,'$.snapshot_path') FROM events_logged
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    ), ranked AS (SELECT id,row_number() OVER(PARTITION BY engagement_id,file ORDER BY created_at DESC,r DESC,tier DESC,id) AS n FROM versions)
    SELECT id FROM ranked WHERE n=1`).all(snapshot?.chainedMaxRowId??Number.MAX_SAFE_INTEGER,snapshot?.loggedMaxRowId??Number.MAX_SAFE_INTEGER) as {id:string}[]).map(row=>row.id)
}
/** Content-ref rows of both tiers. `range` narrows each tier to
 *  `after < rowid <= upTo`; without it, every row inside the boundary. */
function rows(snapshot?: ExportSnapshot, projectId?: string, latest = latestSnapshotIds(snapshot), range?: Array<{ after: number; upTo: number }>) {
  const source = getDB()
  return TIERS.map((table, i) => {
    const max = range ? range[i].upTo : snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
    return source.prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? ${range ? 'AND rowid>?' : ''} ${projectId ? 'AND engagement_id=?' : ''} AND (${BODY_SOURCE_PREDICATE})
      AND (agent_type<>'agent' OR coalesce(subtype,'')<>'transcript_snapshot' OR id IN (SELECT value FROM json_each(?))) ORDER BY rowid`).iterate(max, ...(range ? [range[i].after] : []), ...(projectId ? [projectId] : []),JSON.stringify(latest)) as IterableIterator<{
      id: string
      data: string
      agent_type:string
      r:number
      engagement_id:string|null
    }>
  })
}
/** Bring the index up to what a full walk of the source rows would produce,
 *  doing work for what changed since the last walk rather than for every ref.
 *
 *  - Nothing structural changed: no walk. Re-check the files behind remembered
 *    refs by lstat alone and re-link the events whose file changed, plus
 *    every missing/failed ref.
 *  - Rows only appended inside the same boundary: link the rows above the
 *    watermark, then the same file check. Nothing can need pruning.
 *  - Anything else (rows deleted, a newer transcript snapshot, another export
 *    boundary, a prune, a replaced directory): the full walk and prune, which
 *    is still cheap per ref for every file that has not changed.
 *
 *  Every content-ref row is inserted with a higher rowid than every row
 *  already there while the highest one survives, and source rows are never
 *  updated, so "the row at the old watermark still has its id, and the count
 *  at or below it is unchanged" means the walked prefix is untouched. */
function sync(projectDir: string, snapshot?: ExportSnapshot): void {
  const db = getIndex(projectDir), source = getDB()
  // Persisted with the verifications it vouches for, so a directory replaced
  // while the app was closed is noticed at the next search too.
  const dirs = directorySignature(projectDir)
  const directoriesChanged = (stmt(db, "SELECT value FROM body_index_meta WHERE key='directories'").get() as { value: string } | undefined)?.value !== dirs
  if (directoriesChanged) dirty = true
  const boundary = snapshot ? `${snapshot.chainedMaxRowId}:${snapshot.loggedMaxRowId}` : 'live'
  const latestIds = latestSnapshotIds(snapshot), latest = JSON.stringify(latestIds)
  const previous = walked && !dirty && walked.source === source && walked.boundary === boundary && walked.latest === latest ? walked : null
  const tiers = TIERS.map((table, i) => {
    const bound = snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
    const before = previous?.tiers[i]
    const row = source.prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS max,count(*) FILTER (WHERE rowid<=?) AS below
      FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE})`).get(before?.max ?? 0, bound) as { n: number; max: number; below: number }
    const idAt = (rowid: number): string | null => rowid > 0 ? (source.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid) as { id: string } | undefined)?.id ?? null : null
    const intact = !before || (row.below === before.n && idAt(before.max) === before.idAtMax)
    return { n: row.n, max: row.max, idAtMax: idAt(row.max), intact, after: before?.max ?? 0 }
  })
  // IMMEDIATE: the write lock is waited for at BEGIN (the busy timeout), not
  // refused mid-walk when another connection committed after this one read.
  forgetOnError(() => db.transaction(() => {
    if (directoriesChanged) {
      stmt(db, 'UPDATE body_event_refs SET verified_desc=NULL,verified_file=NULL,verified_sig=NULL').run()
      stmt(db, "INSERT INTO body_index_meta VALUES('directories',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(dirs)
    }
    let full = !previous || tiers.some(t => !t.intact)
    if (!full) {
      const seen = new Set<string>()
      for (const [i, tier] of rows(snapshot, undefined, latestIds, tiers.map(t => ({ after: t.after, upTo: t.max }))).entries())
        for (const row of tier) { seen.add(row.id); linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, TIERS[i], { engagementId: row.engagement_id, row: row.r }) }
      // Ingest linked a row this walk did not reach (outside the boundary):
      // only the full walk's prune removes it.
      full = [...linkedOutsideWalk].some(id => !seen.has(id)) || !recheck(projectDir)
    }
    if (full) walkAll(db, projectDir, snapshot, latestIds, tiers.map(t => ({ after: 0, upTo: t.max })))
  }).immediate())
  walked = { source, boundary, latest, tiers: tiers.map(({ n, max, idAtMax }) => ({ n, max, idAtMax })) }
  linkedOutsideWalk.clear()
  dirty = false
}
function walkAll(db: Database.Database, projectDir: string, snapshot: ExportSnapshot | undefined, latest: string[], range: Array<{ after: number; upTo: number }>): void {
  stmt(db, 'DELETE FROM body_seen').run()
  const seen = stmt(db, 'INSERT OR IGNORE INTO body_seen VALUES(?,?)')
  for (const [i, tier] of rows(snapshot, undefined, latest, range).entries())
    for (const row of tier) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      for (const ref of linkEvent({ id: row.id, data, agentType: row.agent_type }, projectDir, TIERS[i], { engagementId: row.engagement_id, row: row.r })) seen.run(row.id, ref.sha256)
    }
  // The verification lives in the row, so a pruned ref takes it along.
  stmt(db, 'DELETE FROM body_event_refs WHERE NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=body_event_refs.event_id AND s.sha256=body_event_refs.sha256)').run()
  // Documents whose ref is gone or no longer has text: found through
  // body_docs (a plain table), each removed by rowid.
  const orphans = stmt(db, "SELECT doc FROM body_docs d WHERE NOT EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=d.event_id AND r.sha256=d.sha256 AND r.status IN ('indexed','partial'))").all() as { doc: number }[]
  const dropText = stmt(db, 'DELETE FROM body_fts WHERE rowid=?'), dropDoc = stmt(db, 'DELETE FROM body_docs WHERE doc=?')
  for (const { doc } of orphans) { dropText.run(doc); dropDoc.run(doc) }
}
/** Without a walk: re-link the events whose saved file no longer has the
 *  signature it was verified with, and every ref still missing or failed.
 *  False when a ref cannot be traced to its row, which only a full walk fixes. */
function recheck(projectDir: string): boolean {
  const db = getIndex(projectDir)
  const events = new Map<string, Tier | null>(), signatures = new Map<string, string>()
  const verified = stmt(db, 'SELECT event_id,tier,verified_file,verified_sig FROM body_event_refs WHERE verified_desc IS NOT NULL AND verified_file IS NOT NULL')
    .all() as Array<{ event_id: string; tier: Tier | null; verified_file: string; verified_sig: string }>
  for (const ref of verified) {
    let sig = signatures.get(ref.verified_file)
    if (sig === undefined) { sig = fileSignature(ref.verified_file); signatures.set(ref.verified_file, sig) }
    if (sig !== ref.verified_sig) events.set(ref.event_id, ref.tier)
  }
  for (const ref of stmt(db, 'SELECT event_id,tier FROM body_event_refs WHERE verified_desc IS NULL').all() as Array<{ event_id: string; tier: Tier | null }>)
    events.set(ref.event_id, ref.tier)
  for (const [eventId, tier] of events) {
    const row = tier && getDB().prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${tier} WHERE id=?`).get(eventId) as { id: string; data: string; agent_type: string; r: number; engagement_id: string | null } | undefined
    if (!tier || !row) return false
    linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, tier, { engagementId: row.engagement_id, row: row.r })
  }
  return true
}
/** The events that reference one body-store file, from the (event, sha256)
 *  link table rather than a scan of `events`. Only events the index has been
 *  told about appear: `ingest` links scanner rows, and a search links the rest. */
export function eventIdsReferencingBody(sha256: string, projectDir = getProjectDir()): string[] {
  const rows = getIndex(projectDir).prepare("SELECT event_id FROM body_event_refs WHERE sha256=? AND kind='body' AND file=?")
    .all(sha256, `${sha256}.body`) as { event_id: string }[]
  return rows.map(row => row.event_id)
}
export function pruneHttpBodyIndex(sha256: string, projectDir = getProjectDir()): void {
  const db = getIndex(projectDir)
  db.transaction(() => {
    const docs = stmt(db, 'SELECT doc FROM body_docs WHERE sha256=?').all(sha256) as { doc: number }[]
    const drop = stmt(db, 'DELETE FROM body_fts WHERE rowid=?')
    for (const { doc } of docs) drop.run(doc)
    stmt(db, 'DELETE FROM body_docs WHERE sha256=?').run(sha256)
    stmt(db, 'DELETE FROM body_event_refs WHERE sha256=?').run(sha256)
  })()
  // A full walk after a prune puts the ref back as it now is (usually
  // 'missing'); an incremental one would not look at it.
  dirty = true
}
/** Retention must remove derived raw text together with its saved file. */
export function pruneSavedFileIndex(file:string, projectDir=getProjectDir()):void {
  if(!existsSync(path.join(projectDir,'http-body-index.db')))return
  const db=getIndex(projectDir),absolute=path.resolve(file)
  const refs=db.prepare("SELECT event_id,sha256,file FROM body_event_refs WHERE kind<>'body'").all() as {event_id:string;sha256:string;file:string}[]
  db.transaction(()=>{for(const ref of refs)if(path.resolve(projectDir,ref.file)===absolute){
    dropDocs(db,ref.event_id,ref.sha256)
    db.prepare('DELETE FROM body_event_refs WHERE event_id=? AND sha256=?').run(ref.event_id,ref.sha256)
  }})()
  dirty = true
}
/** A raw snapshot spans its Session prefix, not individual target/time/tool rows. */
export function rawTranscriptFiltersUnsupported(conditions: readonly {field:string}[], filter?: {
  targetId?:unknown;since?:unknown;before?:unknown;inScopeOnly?:unknown;hidePersonal?:unknown;tier?:unknown
}): boolean {
  return conditions.some(c=>['tool','transcript','event','operator','source'].includes(c.field)) || Boolean(filter &&
    (filter.targetId || filter.since != null || filter.before != null || filter.inScopeOnly || filter.hidePersonal || filter.tier))
}
export function searchHttpBodyEventIds(query: string, projectDir = getProjectDir(), excludeAiRaw = false,snapshot?:ExportSnapshot): string[] {
  const match = toFtsMatch(query)
  if (!match)
    return []
  // Another writer of the index (the export worker, mid-walk) held it past
  // the busy timeout: answer from the index as it stands. Coverage reads the
  // project's rows, so a ref this left unlinked still shows as pending.
  try { sync(projectDir,snapshot) }
  catch (error) { if (!(error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY'))) throw error }
  const db = getIndex(projectDir)
  // Failed references have already lost their FTS rows. Report them through
  // coverage without withholding unrelated, verified matches.
  // AND remains scoped to one saved body even when its terms occur in
  // different chunks. A term must never be assembled across unrelated refs.
  const terms = ftsTerms(query)
  let matches: Map<string, string> | undefined
  for (const quoted of terms) {
    const rows = stmt(db, `SELECT DISTINCT d.event_id,d.sha256 FROM body_fts JOIN body_docs d ON d.doc=body_fts.rowid WHERE body_fts MATCH ?
      ${excludeAiRaw ? "AND EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=d.event_id AND r.sha256=d.sha256 AND r.kind<>'ai-raw')" : ''}`).all(quoted) as {event_id:string;sha256:string}[]
    const current = new Map(rows.map(row => [JSON.stringify([row.event_id,row.sha256]),row.event_id]))
    matches = matches ? new Map([...matches].filter(([key])=>current.has(key))) : current
    if (!matches.size) break
  }
  return [...new Set(matches?.values() ?? [])]
}
export interface BodySearchCoverage {
  projectId?:string|null
  boundary?:ExportSnapshot
  revision: string
  indexed: number
  missing: number
  binary: number
  limited: number
  /** Indexed as far as it goes: the capture cut the body short, or its
   *  declared charset stopped decoding at the end. */
  partial: number
  pending: number
  failed: number
  indexedBytes: number
  sourceBytes: number
  unsupported?: number
  sources?: SearchCoverageSource[]
}
export interface SearchCoverageSource {
  kind: 'events' | 'body' | 'artifact' | 'ai-raw'
  status: 'covered' | 'partial' | 'pending' | 'unsupported' | 'failed' | 'unavailable'
  revision: string
  indexed: number; missing: number; binary: number; pending: number; failed: number; unsupported: number; limited:number; partial:number
  indexedBytes: number; sourceBytes: number
  representation: 'decoded-event-json' | 'saved-bytes' | 'confirmed-jsonl-prefix'
  precision: 'event' | 'file'
  filters: {applied:string[];unsupported:string[]}
}
interface CoverageEntry {
  eventId: string; kind: IndexedRef['kind']; file: string; sha256: string; size: number; sourceBytes: number; pending: boolean
  status?: string; indexedBytes: number; reason: string; availableBytes: number
}
/** The bytes a ref stands for: what the capture saw when it cut the body
 *  short and said how much there was, else what was saved. */
function sourceBytesOf(ref: IndexedRef): number {
  const size = Number.isSafeInteger(ref.size) && ref.size >= 0 ? ref.size : 0
  return ref.kind === 'body' && ref.truncated && typeof ref.totalSize === 'number' && ref.totalSize > size ? ref.totalSize : size
}
/** Every ref coverage counts, in source order (tier, row, position).
 *
 *  When the last sync left the index describing exactly these rows (same
 *  boundary and transcript prefixes, no row added, removed or linked since),
 *  it is read from body_event_refs, which holds what refsOf derived for each
 *  ref. Otherwise from the source rows, with each ref's index row looked up
 *  (none: pending). Both give the same entries for the same state. */
function coverageEntries(snapshot: ExportSnapshot | undefined, projectId: string | undefined): CoverageEntry[] {
  const source = getDB(), latest = latestSnapshotIds(snapshot)
  const boundary = snapshot ? `${snapshot.chainedMaxRowId}:${snapshot.loggedMaxRowId}` : 'live'
  const current = walked && !dirty && indexDir === getProjectDir() && walked.source === source && walked.boundary === boundary
    && walked.latest === JSON.stringify(latest) && linkedOutsideWalk.size === 0
    && TIERS.every((table, i) => {
      const bound = snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
      const row = source.prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS max FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE})`).get(bound) as { n: number; max: number }
      return row.n === walked!.tiers[i].n && row.max === walked!.tiers[i].max
    })
  if (current) {
    return (stmt(getIndex(), `SELECT event_id,kind,file,sha256,size,source_bytes,status,indexed_bytes,reason,available_bytes FROM body_event_refs
      WHERE @project IS NULL OR engagement_id=@project ORDER BY CASE tier WHEN 'events' THEN 0 ELSE 1 END,row,pos`).all({ project: projectId ?? null }) as Array<{
      event_id: string; kind: IndexedRef['kind']; file: string; sha256: string; size: number; source_bytes: number; status: string; indexed_bytes: number; reason: string; available_bytes: number
    }>).map(r => ({ eventId: r.event_id, kind: r.kind, file: r.file, sha256: r.sha256, size: r.size, sourceBytes: r.source_bytes,
      pending: r.kind === 'ai-raw' && r.status === 'pending', status: r.status, indexedBytes: r.indexed_bytes, reason: r.reason, availableBytes: r.available_bytes }))
  }
  const lookup = stmt(getIndex(), 'SELECT status,indexed_bytes,reason,available_bytes FROM body_event_refs WHERE event_id=? AND sha256=?')
  const entries: CoverageEntry[] = []
  for (const tier of rows(snapshot, projectId, latest)) for (const row of tier) {
    for (const ref of refsOf({ agentType: row.agent_type, data: JSON.parse(row.data) })) {
      const indexed = lookup.get(row.id, ref.sha256) as { status: string; indexed_bytes: number; reason: string; available_bytes: number } | undefined
      entries.push({ eventId: row.id, kind: ref.kind, file: ref.file, sha256: ref.sha256, size: Number.isSafeInteger(ref.size) ? ref.size : 0,
        sourceBytes: sourceBytesOf(ref),
        pending: ref.kind !== 'body' && ref.pending === true, status: indexed?.status, indexedBytes: indexed?.indexed_bytes ?? 0,
        reason: indexed?.reason ?? '', availableBytes: indexed?.available_bytes ?? 0 })
    }
  }
  return entries
}
/** A source-scoped manifest, not a claim that every attachment was indexed. */
export function bodySearchCoverage(snapshot?: ExportSnapshot, projectId?: string, options?: {parsed?:ParsedQuery;filter?:EventFilter}): BodySearchCoverage {
  const coverage: BodySearchCoverage = {projectId:projectId??null,boundary:snapshot,revision:'',indexed:0,missing:0,binary:0,limited:0,partial:0,pending:0,failed:0,indexedBytes:0,sourceBytes:0,unsupported:0,sources:[]}
  const applied = [...(options?.parsed?.conditions.map(c=>c.field)??[]),
    ...Object.entries(options?.filter??{}).filter(([,v])=>v!=null&&v!==false&&v!=='').map(([key])=>key)].sort()
  const rawUnsupported = applied.filter(key=>['tool','transcript','event','operator','source','targetId','since','before','inScopeOnly','hidePersonal','tier'].includes(key))
  const groups = new Map<string,SearchCoverageSource>()
  const hashes = new Map<string,ReturnType<typeof createHash>>()
  for (const kind of ['events','body','artifact','ai-raw'] as const) {
    const unsupported = kind==='ai-raw'?rawUnsupported:[]
    groups.set(kind,{kind,status:'covered',revision:'',indexed:0,missing:0,binary:0,pending:0,failed:0,unsupported:0,limited:0,partial:0,indexedBytes:0,sourceBytes:0,
      representation:kind==='events'?'decoded-event-json':kind==='ai-raw'?'confirmed-jsonl-prefix':'saved-bytes',precision:kind==='events'?'event':'file',
      filters:{applied:applied.filter(key=>!unsupported.includes(key)),unsupported}})
    hashes.set(kind,createHash('sha256').update(`saved-index-v${INDEX_VERSION}`).update(JSON.stringify([applied,unsupported])))
  }
  const eventGroup=groups.get('events')!,eventHash=hashes.get('events')!
  for(const [table,max] of [['events',snapshot?.chainedMaxRowId],['events_logged',snapshot?.loggedMaxRowId]] as const){
    const row=getDB().prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS tail FROM ${table}
      WHERE rowid<=? ${projectId?'AND engagement_id=?':''}`).get(max??Number.MAX_SAFE_INTEGER,...(projectId?[projectId]:[])) as {n:number;tail:number}
    eventGroup.indexed+=row.n;eventHash.update(JSON.stringify([table,row.n,row.tail]))
  }
  const confirmed = new Set<string>()
  const pending: CoverageEntry[] = []
  const record = (entry: CoverageEntry): void => {
      const excluded=entry.kind==='ai-raw'&&rawUnsupported.length>0
      const key=excluded?'unsupported':entry.status??'pending'
      const group=groups.get(entry.kind)!
      if(key==='indexed'||key==='partial'||key==='missing'||key==='binary'||key==='pending'||key==='failed'||key==='unsupported'||key==='limited')group[key]++
      group.sourceBytes+=entry.sourceBytes;group.indexedBytes+=excluded?0:entry.indexedBytes
      if(entry.kind==='ai-raw'&&!excluded&&entry.status==='indexed'&&entry.availableBytes>entry.size){
        group.pending++;group.sourceBytes+=entry.availableBytes-entry.size
      }
      hashes.get(entry.kind)!.update(JSON.stringify([entry.eventId,entry.file,entry.sha256,entry.size,key,entry.reason,entry.availableBytes]))
  }
  // Only small pending-AI references need to wait for confirmed snapshots.
  for (const entry of coverageEntries(snapshot, projectId)) {
    if (entry.kind === 'ai-raw' && entry.pending) pending.push(entry)
    else {
      if (entry.kind === 'ai-raw') confirmed.add(path.resolve(getProjectDir(), entry.file))
      record(entry)
    }
  }
  for (const entry of pending) {
    if (!confirmed.has(path.resolve(getProjectDir(), entry.file))) record(entry)
  }
  const hash=createHash('sha256')
  for(const group of groups.values()){
    group.status=group.failed?'failed':group.missing?'unavailable':group.pending?(group.indexed||group.partial?'partial':'pending'):group.unsupported||group.binary||group.limited||group.partial?(group.indexed||group.partial?'partial':'unsupported'):'covered'
    group.revision=hashes.get(group.kind)!.digest('hex')
    hash.update(group.revision)
    if(group.kind!=='events') {
      for(const key of ['indexed','missing','binary','pending','failed','limited','partial','indexedBytes','sourceBytes'] as const)coverage[key]+=group[key]
      coverage.unsupported!+=group.unsupported
    }
    coverage.sources!.push(group)
  }
  coverage.revision=hash.digest('hex')
  return coverage
}
