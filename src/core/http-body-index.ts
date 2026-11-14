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
import { ftsTerms, FTS_TOKENIZE } from './query/fts-match'
import { compareCodeUnits } from './code-unit-order'
import { BODY_REF_FIELDS, type BodyRef } from './http-body-store'
import { withVerifiedBody, withVerifiedSavedFile, savedFileRefs, withInlineBase64, ContentAccessError, type ByteSource, type SavedFileRef } from './body-source'
const INDEX_CHUNK_BYTES = 1024 * 1024
const INDEX_OVERLAP_CHARS = 65536
const INDEX_VERSION = 11
// ── Where a document is ──────────────────────────────────────────────────
// A ref's documents are found by arithmetic, not looked up: document n
// (from 0) of kind k (0: the saved text, 1: the decoded text) of ref r is
// rowid r*REF_SPAN + k*KIND_SPAN + n, and the ref row records how many of
// each kind it has, so removing them is a point delete per document.
// ftsWriter writes at most one document per part it is given, and a read
// gives each stream one part per INDEX_CHUNK_BYTES of source plus a tail and
// a final call: a body of B bytes makes at most ceil(B / 1 MiB) + 2 of each
// kind, 12 at the default capture cap (REDLOG_MAX_BODY, 10 MiB). KIND_SPAN
// leaves room for a raised cap or none (0 is unlimited), and for saved
// artifacts and transcripts, which no cap bounds: about 2 GiB of one kind.
// A body that needs more is indexed as far as that goes, `partial` with
// reason 'too-large', never written into the next ref's rowids. MAX_REF
// keeps every rowid below 2^53, so a rowid is exact as a JS number (and far
// inside 63 bits); the table refuses a ref id at or above it.
const KIND_SPAN = 2048, REF_SPAN = 2 * KIND_SPAN, MAX_REF = 2 ** 41
type DocKind = 0 | 1
function rowidOf(ref: number, kind: DocKind, n: number): number {
  if (!Number.isSafeInteger(ref) || ref < 1 || ref >= MAX_REF || (kind !== 0 && kind !== 1) || !Number.isSafeInteger(n) || n < 0 || n >= KIND_SPAN)
    throw new RangeError(`No document rowid for ref ${ref}, kind ${kind}, document ${n}`)
  return ref * REF_SPAN + kind * KIND_SPAN + n
}
/** Test seams: the layout, and the rowid of one document. */
export function _documentLayout(): { refSpan: number; kindSpan: number; maxRef: number } { return { refSpan: REF_SPAN, kindSpan: KIND_SPAN, maxRef: MAX_REF } }
export function _documentRowid(ref: number, kind: DocKind, n: number): number { return rowidOf(ref, kind, n) }
/** The documents one ref may hold of each kind. KIND_SPAN; a test lowers it
 *  to reach the limit with a small body. */
let documentsPerKind = KIND_SPAN
export function _limitDocumentsPerKind(n?: number): void { documentsPerKind = Math.min(n ?? KIND_SPAN, KIND_SPAN) }
class TooManyDocuments extends Error {}
let index: Database.Database | null = null, indexDir: string | null = null
function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir)
    return index
  closeHttpBodyIndex()
  // A search that finds the write lock held waits at most this long, on the
  // main thread, before it answers from what is there (readPlan). Only main's
  // own connection writes the index, so in practice nobody holds it.
  const db = index = new Database(path.join(projectDir, 'http-body-index.db'), { timeout: 1000 })
  db.pragma('journal_mode = WAL')
  // `synchronous` stays at the WAL default (NORMAL), unlike timeline.db: an
  // OS crash loses the last commits whole, the watermark (see sync) with the
  // rows it vouches for, and the next search links those rows again.
  // Rebuild only this disposable index, never a source Event or sidecar.
  // v7 added the verification columns below; v9 adds the decoded text of
  // JSON escapes and of bodies in a declared charset, body_docs, and what
  // coverage needs per ref (engagement, source row, order, source bytes), so
  // coverage reads this table instead of re-deriving every row's refs. v10
  // keys a ref by its event and the field it is in (its slot), not by its
  // hash: a request and a response with the same bytes are two refs. v11
  // gives each ref an id of its own, never reused, and derives its
  // documents' rowids from it (see KIND_SPAN); body_docs is gone.
  // An older index is rebuilt once, from the source rows, at the next search.
  // The schema is written in one transaction, and an index already current is
  // opened without a write: each commit is a flush, slow on Windows.
  if (db.pragma('user_version', { simple: true }) !== INDEX_VERSION) db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_docs; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state; DROP TABLE IF EXISTS body_index_meta')
    // FTS5 finds a row only by MATCH or rowid: a document's rowid says which
    // ref it is (rowid / REF_SPAN), so removing one ref's text never reads
    // every document.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,tokenize='${FTS_TOKENIZE}',prefix='2 3');
    CREATE TABLE IF NOT EXISTS body_event_refs (${REF_COLUMNS});
    CREATE INDEX IF NOT EXISTS body_event_refs_sha256 ON body_event_refs(sha256);
    CREATE INDEX IF NOT EXISTS body_event_refs_order ON body_event_refs(tier,row,pos);
    CREATE TABLE IF NOT EXISTS body_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    db.pragma(`user_version=${INDEX_VERSION}`)
  })()
  db.exec('CREATE TEMP TABLE body_seen(event_id TEXT NOT NULL,slot TEXT NOT NULL,PRIMARY KEY(event_id,slot));')
  indexDir = projectDir
  return index
}
export function closeHttpBodyIndex(): void { if (index) {
  try {
    index.close()
  }
  catch { }
} index = null; indexDir = null; statements = new Map() }

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
// with the row. So is the watermark of what the index describes (see sync), so
// a restart, or another connection to the same index, carries on from it.
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
let statements = new Map<string, Database.Statement>()
/** Where a ref and its documents are written: the shared index, which only
 *  main's read-write connection writes, or this connection's TEMP tables, for
 *  what one call reads that the shared index does not vouch for (readPlan). */
interface Tables { refs: string; fts: string }
const SHARED: Tables = { refs: 'body_event_refs', fts: 'body_fts' }
const EXTRA: Tables = { refs: 'body_x_refs', fts: 'body_x_fts' }
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
/** A ref row's id and how many documents of each kind it holds. */
interface RefDocs { ref: number; raw_docs: number; decoded_docs: number }
/** Delete documents `from` to `to` (exclusive) of one kind of a ref, each by
 *  its rowid: never a rowid range, which FTS5 answers by reading the table. */
function dropRange(db: Database.Database, t: Tables, ref: number, kind: DocKind, from: number, to: number): void {
  if (from >= to) return
  const drop = stmt(db, `DELETE FROM ${t.fts} WHERE rowid=?`)
  for (let n = from; n < to; n++) drop.run(rowidOf(ref, kind, n))
}
/** Remove one ref's documents: O(its documents). */
function dropDocs(db: Database.Database, row: RefDocs, t = SHARED): void {
  dropRange(db, t, row.ref, 0, 0, row.raw_docs)
  dropRange(db, t, row.ref, 1, 0, row.decoded_docs)
}
// Inline bodies whose escapes were scanned and hashed by refsOf; a test seam
// for "a search does no per-row work for rows already linked".
let inlineRefWork = 0
export function _inlineRefWork(): number { return inlineRefWork }
/** Events this connection's TEMP tables hold; a test seam for "TEMP keeps
 *  only what the last call needed". */
export function _extraEvents(projectDir = getProjectDir()): number {
  const db = getIndex(projectDir)
  return hasExtraTables(db) ? (stmt(db, 'SELECT count(DISTINCT event_id) AS n FROM body_x_refs').get() as { n: number }).n : 0
}
/** The shared index is written only through main's read-write source
 *  connection. On a read-only one (the export worker) its writers do nothing:
 *  none of them is reached there today, and a throw on a path an export can
 *  reach would fail the export. Nothing is lost: main's next sync re-checks
 *  every file and re-links what ingest would have. */
function readOnlySource(): boolean {
  try { return getDB().readonly } catch { return false }
}
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
type BodyIndexRef = BodyRef & {kind:'body';inline?:string;decode:boolean;charset?:string;slot:string}
/** `slot`: the field of the event the ref is in. An event's refs are told
 *  apart by it, never by hash: a request and a response may be the same bytes. */
type IndexedRef = BodyIndexRef | (SavedFileRef & {kind:'artifact'|'ai-raw';encoding:'text';slot:string})
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
        ? [{slot:field,sha256:ref.sha256,file:ref.file,size:ref.size,
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
        return [{kind:'body' as const,slot:`inline:${field}`,file:`inline:${field}`,sha256:createHash('sha256').update(value.data).digest('hex'),
          size,encoding:'base64' as const,inline:value.data,decode,...cut(size),...(charset ? {charset} : {})}]
      }
      // Inline text is in the events index already, as written. Only a body
      // with an escape to decode needs a body-index entry, and that entry
      // holds the decoded text alone.
      if(atIngest||!decode)return []
      inlineRefWork++
      if(decodeJsonEscapes(value.data)===null)return []
      const size=Buffer.byteLength(value.data,'utf8')
      return [{kind:'body' as const,slot:`inline:${field}`,file:`inline:${field}`,sha256:createHash('sha256').update(value.data).digest('hex'),
        size,encoding:'text' as const,inline:value.data,decode,...cut(size)}]
    }),
    ...savedFileRefs(event).map(ref=>({...ref,slot:ref.field,kind:ref.field==='artifact'?'artifact' as const:'ai-raw' as const,encoding:'text' as const}))
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
/** At ingest: link a scanner event's saved and base64 bodies now, so retention
 *  can find the events behind a file. The row is above the watermark, so the
 *  next search reaches it like any new row (and finds it already verified); an
 *  event with no body writes nothing. */
export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data' | 'engagementId'> & {agentType?:string}, projectDir = getProjectDir()): void {
  if (readOnlySource()) return
  linkEvent(event, projectDir, null, { engagementId: event.engagementId ?? null, row: null }, true)
}
interface SourceRow { engagementId: string | null; row: number | null }
/** Link one event's refs; returns them, for the walk's record of what it saw. */
function linkEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir: string, tier: Tier | null, source: SourceRow, atIngest = false, t = SHARED): IndexedRef[] {
  const db = getIndex(projectDir)
  const refs = refsOf(event, atIngest)
  // Inside a walk's transaction no savepoint per event: an error that escapes
  // aborts the whole walk anyway. A ref whose read ends missing or failed does
  // not escape; it continues, and removes the documents it wrote.
  const atomic = (run: () => void): void => { if (db.inTransaction) run(); else db.transaction(run)() }
  if (refs.length) atomic(() => {
    for (const [pos, ref] of refs.entries()) {
      let status = 'indexed', bytes = 0, reason = '',availableBytes=0
      const prior = stmt(db, `SELECT ref,raw_docs,decoded_docs,status,reason,tier,row,pos,verified_desc,verified_file,verified_sig FROM ${t.refs} WHERE event_id=? AND slot=?`).get(event.id, ref.slot) as RefDocs & {
        status: string; reason: string; tier: Tier | null; row: number | null; pos: number; verified_desc: string | null; verified_file: string | null; verified_sig: string | null
      } | undefined
      const file = refFile(ref, projectDir)
      const body = ref.kind === 'body' ? ref : null
      const desc = JSON.stringify([ref.sha256, ref.file, ref.size, ref.encoding ?? null, ref.kind, ref.kind !== 'body' && ref.pending === true, body?.inline !== undefined,
        body?.decode ?? false, body?.charset ?? null, body?.truncated === true, body?.totalSize ?? null])
      // Nothing that decides this row has changed since it was verified.
      if (prior && prior.verified_desc === desc && FINAL_STATUSES.has(prior.status)
        && (prior.verified_file === null || (prior.verified_file === file && fileSignature(prior.verified_file) === prior.verified_sig))) {
        // Ingest links without the inline text refs, so the position is set
        // here too.
        if (tier && (prior.tier !== tier || prior.row !== source.row || prior.pos !== pos))
          stmt(db, `UPDATE ${t.refs} SET tier=?,row=?,pos=?,engagement_id=coalesce(?,engagement_id) WHERE event_id=? AND slot=?`).run(tier, source.row, pos, source.engagementId, event.id, ref.slot)
        continue
      }
      // The ref's id: its row's, or, for a ref new to the table, one taken by
      // inserting its row before its first document is written.
      let id = prior?.ref
      // Documents of each kind this ref held, and this read has written.
      const had: [number, number] = [prior?.raw_docs ?? 0, prior?.decoded_docs ?? 0], wrote: [number, number] = [0, 0]
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
          if (prior && HAS_DOCS.has(prior.status)) { status = prior.status; reason = prior.reason; wrote[0] = had[0]; wrote[1] = had[1]; return }
          // Every document write replaces: whatever a rowid of this ref held
          // is overwritten, never added to (a plain INSERT at a rowid FTS5
          // already holds keeps the old words searchable beside the new).
          const insertText = stmt(db, `INSERT OR REPLACE INTO ${t.fts}(rowid,content) VALUES(?,?)`)
          const write = (kind: DocKind) => (part: string): void => {
            if (!part) return
            if (wrote[kind] >= documentsPerKind) throw new TooManyDocuments()
            id ??= Number(stmt(db, `INSERT INTO ${t.refs}(event_id,slot,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,pos,source_bytes)
              VALUES(?,?,?,?,0,'',?,0,'',?,0,?,0)`).run(event.id, ref.slot, ref.sha256, ref.file, 'failed', ref.kind, pos).lastInsertRowid)
            insertText.run(rowidOf(id, kind, wrote[kind]), part)
            wrote[kind]++
          }
          // The saved text, unless it is inline text the events index already
          // holds; and, in the same pass, once an escape has been seen, the
          // decoded text as a second document of the same (event, body) pair,
          // so it is pruned, verified and counted with the saved text. The
          // decoded document starts INDEX_OVERLAP_CHARS before the first
          // escape (at a token boundary): a term is one document's phrase,
          // and text further back is the saved document's, unchanged.
          const inlineText = body?.inline !== undefined && body.encoding === 'text'
          const saved = inlineText ? null : ftsWriter(write(0))
          const escapes = body?.decode ? jsonEscapeDecoder() : null
          let decoded: ReturnType<typeof ftsWriter> | null = null, lead = '', leadCut = false
          const startDecoded = (text: string, final: boolean): void => {
            decoded = ftsWriter(write(1))
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
            // Indexed as far as this ref's rowids go; the rest is not searched.
            if (error instanceof TooManyDocuments) { status = 'partial'; reason = 'too-large' }
            else if (strict || !(error instanceof TypeError || error instanceof NotText)) throw error
            else { bytes = 0; status = 'binary'; reason = 'binary' }
          }
          if (status === 'indexed' && body?.truncated) { status = 'partial'; reason = 'truncated' }
        })
      }
      catch (error) {
        bytes = 0
        status = error instanceof ContentAccessError && error.status === 'missing' ? 'missing' : error instanceof ContentAccessError && error.status==='unsupported'?'limited':'failed'
        reason = error instanceof ContentAccessError ? error.status : 'failed'
      }
      // A ref keeps the documents this read wrote, and only if it ended with
      // text. Everything else its rowids may hold goes now, by rowid: the
      // documents it had, when this read ended without text, and the ones this
      // read wrote before the file vanished or changed under it (missing and
      // failed are retried every search: kept, they would be found while
      // coverage says missing, and outlive the file coming back).
      const keep: [number, number] = HAS_DOCS.has(status) ? wrote : [0, 0]
      if (id !== undefined) for (const kind of [0, 1] as const) dropRange(db, t, id, kind, keep[kind], Math.max(had[kind], wrote[kind]))
      // pending/limited come from the event alone; indexed/binary/partial from
      // bytes whose signature is recorded. missing/failed can change with no
      // new row (a file restored or repaired), so they carry no verification
      // and are retried every search.
      const final = FINAL_STATUSES.has(status)
      const size = Number.isSafeInteger(ref.size) ? ref.size : 0
      const sourceBytes = sourceBytesOf(ref)
      const values = { ref: id ?? null, rawDocs: keep[0], decodedDocs: keep[1], event: event.id, slot: ref.slot, sha256: ref.sha256, file: ref.file, size, encoding: String(ref.encoding ?? 'unknown'), status,
        bytes, reason, kind: ref.kind, available: availableBytes, tier, desc: final ? desc : null, verifiedFile: final && status !== 'pending' ? file : null,
        sig: final && status !== 'pending' ? sig : null, engagement: source.engagementId, row: source.row, pos, sourceBytes }
      // An existing ref is updated by its id, never upserted: an upsert that
      // changes nothing still takes an AUTOINCREMENT id, and writes.
      if (values.ref === null) stmt(db, `INSERT INTO ${t.refs}(event_id,slot,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,tier,verified_desc,verified_file,verified_sig,engagement_id,row,pos,source_bytes,raw_docs,decoded_docs)
    VALUES(@event,@slot,@sha256,@file,@size,@encoding,@status,@bytes,@reason,@kind,@available,@tier,@desc,@verifiedFile,@sig,@engagement,@row,@pos,@sourceBytes,@rawDocs,@decodedDocs)`).run(values)
      // A missing or failed ref retried with the same outcome changes nothing:
      // no write, so a search that finds nothing new commits nothing.
      else stmt(db, `UPDATE ${t.refs} SET sha256=@sha256,file=@file,size=@size,encoding=@encoding,status=@status,indexed_bytes=@bytes,reason=@reason,kind=@kind,available_bytes=@available,
    tier=coalesce(@tier,tier),verified_desc=@desc,verified_file=@verifiedFile,verified_sig=@sig,engagement_id=coalesce(@engagement,engagement_id),row=coalesce(@row,row),pos=@pos,source_bytes=@sourceBytes,
    raw_docs=@rawDocs,decoded_docs=@decodedDocs
    WHERE ref=@ref AND ((sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,verified_desc,verified_file,verified_sig,pos,source_bytes,raw_docs,decoded_docs)
      IS NOT (@sha256,@file,@size,@encoding,@status,@bytes,@reason,@kind,@available,@desc,@verifiedFile,@sig,@pos,@sourceBytes,@rawDocs,@decodedDocs)
      OR coalesce(@tier,tier) IS NOT tier OR coalesce(@row,row) IS NOT row OR coalesce(@engagement,engagement_id) IS NOT engagement_id)`).run(values)
    }
  })
  return refs
}
type Bounds = readonly [number, number]
/** No boundary: every row of both tiers. */
const LIVE: Bounds = Object.freeze([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const)
const boundsOf = (snapshot?: ExportSnapshot): Bounds => snapshot ? [snapshot.chainedMaxRowId, snapshot.loggedMaxRowId] : LIVE
interface Latest { id: string; tier: Tier; r: number; engagementId: string | null }
/** The latest confirmed transcript snapshot of each saved file, per project,
 *  inside `snapshot` (or the whole project). A snapshot is a cumulative prefix
 *  of one saved file: the latest version is indexed, not every prefix. */
function latestSnapshots(snapshot?: ExportSnapshot): Latest[] {
  const [chained, logged] = boundsOf(snapshot)
  return (getDB().prepare(`WITH versions AS (
    SELECT id,engagement_id,created_at,rowid AS r,1 AS tier,json_extract(data,'$.snapshot_path') AS file FROM events
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    UNION ALL SELECT id,engagement_id,created_at,rowid,0,json_extract(data,'$.snapshot_path') FROM events_logged
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    ), ranked AS (SELECT id,engagement_id,r,tier,row_number() OVER(PARTITION BY engagement_id,file ORDER BY created_at DESC,r DESC,tier DESC,id) AS n FROM versions)
    SELECT id,engagement_id,r,tier FROM ranked WHERE n=1`).all(chained, logged) as Array<{ id: string; engagement_id: string | null; r: number; tier: number }>)
    .map(row => ({ id: row.id, tier: row.tier === 1 ? 'events' : 'events_logged', r: row.r, engagementId: row.engagement_id }))
}
/** A transcript snapshot row counts only when its id is in the bound JSON list of latest prefixes. */
const ONLY_LATEST_PREFIX = "(agent_type<>'agent' OR coalesce(subtype,'')<>'transcript_snapshot' OR id IN (SELECT value FROM json_each(?)))"
interface ContentRow { id: string; data: string; agent_type: string; r: number; engagement_id: string | null }
/** Content-ref rows of both tiers inside `bounds`, transcript snapshots only
 *  when in `latest`. `range` narrows each tier to `after < rowid <= upTo`. */
function rows(bounds: Bounds, projectId: string | undefined, latest: string[], range?: Array<{ after: number; upTo: number }>): IterableIterator<ContentRow>[] {
  const source = getDB()
  return TIERS.map((table, i) => source.prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? ${range ? 'AND rowid>?' : ''} ${projectId ? 'AND engagement_id=?' : ''} AND (${BODY_SOURCE_PREDICATE})
      AND ${ONLY_LATEST_PREFIX} ORDER BY rowid`)
    .iterate(range ? Math.min(range[i].upTo, bounds[i]) : bounds[i], ...(range ? [range[i].after] : []), ...(projectId ? [projectId] : []), JSON.stringify(latest)) as IterableIterator<ContentRow>)
}
const linkRow = (row: ContentRow, projectDir: string, tier: Tier, t = SHARED): IndexedRef[] =>
  linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, tier, { engagementId: row.engagement_id, row: row.r }, false, t)

// ── What the index describes ─────────────────────────────────────────────
// The shared index describes the live project as main's read-write
// connection last saw it: every content-ref row, with the latest transcript
// prefix of each saved file. Only that connection writes it (see readPlan for
// everyone else), and a snapshot is never a reason to write: a call bounded by
// one filters by it when it reads (each ref keeps its tier and row), so
// alternating live and snapshot calls is not a change of boundary.
//
// The watermark ('mark' in body_index_meta) says which rows the index
// describes: per tier the count and highest rowid of content-ref rows and the
// id at that rowid, and the latest transcript prefixes. It is written in the
// transaction that brings the index there, so it is never ahead of the
// index, it survives a restart, and another connection reads it. A prune,
// a replaced directory or a rebuild removes it, and main's next search walks
// every row again.
//
// Every content-ref row is inserted with a higher rowid than every row
// already there while the highest one survives, and source rows are never
// updated, so "the row at the old highest rowid still has its id, and the
// count at or below it is unchanged" means the described prefix is untouched.
interface Mark { latest: string[]; tiers: Array<{ n: number; max: number; idAtMax: string | null }> }
function readMark(db: Database.Database): Mark | null {
  const row = stmt(db, "SELECT value FROM body_index_meta WHERE key='mark'").get() as { value: string } | undefined
  if (!row) return null
  const mark = JSON.parse(row.value) as Mark
  return Array.isArray(mark.latest) && Array.isArray(mark.tiers) && mark.tiers.length === TIERS.length ? mark : null
}
function forgetMark(db: Database.Database): void { stmt(db, "DELETE FROM body_index_meta WHERE key='mark'").run() }
interface TierState { n: number; max: number; idAtMax: string | null; intact: boolean; after: number }
/** Each tier's content-ref rows now, and whether the prefix `mark` describes
 *  is untouched. Counts the partial index; reads no row. */
function sourceState(mark: Mark | null): TierState[] {
  const source = getDB()
  return TIERS.map((table, i) => {
    const before = mark?.tiers[i]
    const row = source.prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS max,count(*) FILTER (WHERE rowid<=?) AS below
      FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE})`).get(before?.max ?? 0, Number.MAX_SAFE_INTEGER) as { n: number; max: number; below: number }
    const idAt = (rowid: number): string | null => rowid > 0 ? (source.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid) as { id: string } | undefined)?.id ?? null : null
    const intact = before !== undefined && row.below === before.n && idAt(before.max) === before.idAtMax
    return { n: row.n, max: row.max, idAtMax: idAt(row.max), intact, after: before?.max ?? 0 }
  })
}
/** Remove every ref of one event, and their documents. */
function dropEvent(db: Database.Database, eventId: string): void {
  for (const row of stmt(db, 'SELECT ref,raw_docs,decoded_docs FROM body_event_refs WHERE event_id=?').all(eventId) as RefDocs[]) dropDocs(db, row)
  stmt(db, 'DELETE FROM body_event_refs WHERE event_id=?').run(eventId)
}
/** Bring the index up to the live project, doing work for what changed since
 *  the watermark rather than for every ref. Main's read-write connection only:
 *  a read-only one never calls this (see readPlan).
 *
 *  - Prefix untouched: link the rows above the watermark (none, often), drop
 *    a transcript prefix a newer row superseded, then re-check the files
 *    behind remembered refs by lstat alone and re-link the events whose file
 *    changed, plus every missing/failed ref.
 *  - Anything else (no watermark, rows deleted, a superseding row that is not
 *    new, a replaced directory, a prune, a missing or failed ref whose row is
 *    gone): the full walk and prune, which is still cheap per ref for every
 *    file that has not changed. */
function sync(projectDir: string): void {
  const db = getIndex(projectDir)
  // Persisted with the verifications it vouches for, so a directory replaced
  // while the app was closed is noticed at the next search too.
  const dirs = directorySignature(projectDir)
  // IMMEDIATE: the write lock is waited for at BEGIN (the busy timeout), not
  // refused mid-walk when another connection committed after this one read.
  db.transaction(() => {
    // Under the lock, like the watermark it is compared with.
    const latest = latestSnapshots(), latestIds = latest.map(l => l.id).sort(compareCodeUnits)
    const directoriesChanged = (stmt(db, "SELECT value FROM body_index_meta WHERE key='directories'").get() as { value: string } | undefined)?.value !== dirs
    if (directoriesChanged) {
      stmt(db, 'UPDATE body_event_refs SET verified_desc=NULL,verified_file=NULL,verified_sig=NULL').run()
      stmt(db, "INSERT INTO body_index_meta VALUES('directories',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(dirs)
    }
    // Read under the write lock: another connection may have moved it.
    const mark = directoriesChanged ? null : readMark(db)
    const tiers = sourceState(mark)
    let full = mark === null || tiers.some(t => !t.intact)
    if (mark && !full) {
      const held = new Set(mark.latest), now = new Set(latestIds)
      // A prefix that became the latest is a new row unless a newer one was
      // deleted, which only the full walk puts right.
      full = latest.some(l => !held.has(l.id) && l.r <= mark.tiers[TIERS.indexOf(l.tier)].max)
      if (!full) {
        for (const id of mark.latest) if (!now.has(id)) dropEvent(db, id)
        for (const [i, tier] of rows(LIVE, undefined, latestIds, tiers.map(t => ({ after: t.after, upTo: t.max }))).entries())
          for (const row of tier) linkRow(row, projectDir, TIERS[i])
        full = !recheck(projectDir)
      }
    }
    if (full) walkAll(db, projectDir, latestIds, tiers.map(t => ({ after: 0, upTo: t.max })))
    const next: Mark = { latest: latestIds, tiers: tiers.map(({ n, max, idAtMax }) => ({ n, max, idAtMax })) }
    // Unchanged, it is not written: a commit is a flush, slow on Windows.
    stmt(db, "INSERT INTO body_index_meta VALUES('mark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value").run(JSON.stringify(next))
  }).immediate()
}
function walkAll(db: Database.Database, projectDir: string, latest: string[], range: Array<{ after: number; upTo: number }>): void {
  stmt(db, 'DELETE FROM body_seen').run()
  const seen = stmt(db, 'INSERT OR IGNORE INTO body_seen VALUES(?,?)')
  for (const [i, tier] of rows(LIVE, undefined, latest, range).entries())
    for (const row of tier) for (const ref of linkRow(row, projectDir, TIERS[i])) seen.run(row.id, ref.slot)
  // Refs no row has any more: their documents, each by rowid, then the rows.
  // The verification lives in the row, so a pruned ref takes it along. (A ref
  // without text holds no document: its row says so, and the table checks.)
  const unseen = 'NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=body_event_refs.event_id AND s.slot=body_event_refs.slot)'
  for (const row of stmt(db, `SELECT ref,raw_docs,decoded_docs FROM body_event_refs WHERE ${unseen}`).all() as RefDocs[]) dropDocs(db, row)
  stmt(db, `DELETE FROM body_event_refs WHERE ${unseen}`).run()
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
    const row = tier && getDB().prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${tier} WHERE id=?`).get(eventId) as ContentRow | undefined
    if (!tier || !row) return false
    linkRow(row, projectDir, tier)
  }
  return true
}
// `ref`: the ref's own id, never reused (AUTOINCREMENT): a new ref that took
// a dead ref's id would take any of its documents that were not removed.
// `raw_docs`, `decoded_docs`: how many documents of each kind it holds, at
// the rowids rowidOf gives; none unless it has text.
const REF_COLUMNS = `ref INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,slot TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
     status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,
     tier TEXT,verified_desc TEXT,verified_file TEXT,verified_sig TEXT,
     engagement_id TEXT,row INTEGER,pos INTEGER NOT NULL,source_bytes INTEGER NOT NULL,
     raw_docs INTEGER NOT NULL DEFAULT 0 CHECK(raw_docs BETWEEN 0 AND ${KIND_SPAN}),decoded_docs INTEGER NOT NULL DEFAULT 0 CHECK(decoded_docs BETWEEN 0 AND ${KIND_SPAN}),
     CHECK(ref BETWEEN 1 AND ${MAX_REF - 1}),CHECK(status IN ('indexed','partial') OR raw_docs+decoded_docs=0),UNIQUE(event_id,slot)`
const hasExtraTables = (db: Database.Database): boolean =>
  stmt(db, "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='body_x_refs'").get() !== undefined
function ensureExtraTables(db: Database.Database): void {
  // The same layout: this connection's own ref ids, never mixed with the
  // shared table's (a TEMP match is joined to TEMP refs only).
  if (!hasExtraTables(db)) db.exec(`CREATE TEMP TABLE body_x_refs (${REF_COLUMNS});
    CREATE VIRTUAL TABLE temp.body_x_fts USING fts5(content,tokenize='${FTS_TOKENIZE}',prefix='2 3');`)
}
/** Remove one event's refs and documents from this connection's TEMP tables. */
function dropExtra(db: Database.Database, eventId: string): void {
  for (const row of stmt(db, 'SELECT ref,raw_docs,decoded_docs FROM body_x_refs WHERE event_id=?').all(eventId) as RefDocs[]) dropDocs(db, row, EXTRA)
  stmt(db, 'DELETE FROM body_x_refs WHERE event_id=?').run(eventId)
}

// ── How one call reads ───────────────────────────────────────────────────
// Only main's read-write source connection writes the shared index: it
// syncs, links at ingest and prunes. A connection whose source is read-only —
// the export worker, which holds one read transaction for a whole export —
// never writes it (beyond creating the schema of an index that is missing or
// at an older version, which holds nothing either way): it never walks, never
// prunes and never moves the watermark. Every call, writer or not, then reads
// the shared index where it vouches for this connection's view of the
// source, and reads the rest from this connection's TEMP tables, which hold
// exactly what the last call needed:
//
// - rows inside the boundary the watermark does not cover (a reader whose
//   view is ahead of main's last sync; main while the lock was held);
// - the transcript prefixes latest inside the boundary that the shared index
//   does not hold (a newer one superseded them there);
// - for a reader, the refs whose file changed since they were verified, and
//   the missing and failed ones, which main's sync retries and a reader
//   cannot.
interface Local { id: string; tier: Tier; r: number }
interface ReadPlan {
  /** Per tier: shared refs of rows at or below this are read from the shared index (-1: none). */
  upTo: [number, number]
  /** Events read from this connection's TEMP tables instead. */
  local: Local[]
  /** Events whose shared refs are not read: a transcript prefix that is not
   *  the latest inside the boundary, and every local event. */
  skip: string[]
}
/** What the shared index vouches for in this connection's view of the source:
 *  per tier, the highest rowid it describes for this view, or null for none.
 *
 *  A view is *behind* the watermark in a tier when its highest content-ref
 *  rowid is below the watermark's. Only a read-only connection is ever behind:
 *  main's read-write connection sees every commit, so for it a lower highest
 *  rowid means rows were deleted or the database replaced, and its sync walks
 *  before it reads. In a tier where the view is behind, the shared index
 *  vouches for the view's rows when it holds refs for exactly as many rows at
 *  or below the view's highest rowid as the view has content-ref rows there
 *  (counting only the transcript prefixes the watermark holds), and the last
 *  row it holds there is the same event at the same rowid in the view. Rows
 *  are only ever added above the highest rowid, so the index cannot hold a
 *  row there that the view lacks unless a rowid was reused, which the event
 *  check sees; a row the view has and the index no longer describes (deleted
 *  by retention since the view was taken, or a rowid reused after every row
 *  was) makes the counts differ. A row that yields no ref at all also makes
 *  them differ, and the view is read locally: slower, never wrong. Where the
 *  view is at or above the watermark, the watermark's prefix must be intact
 *  in it. Both tiers must pass, or the shared index vouches for nothing in
 *  this view. */
function vouchedFor(db: Database.Database, mark: Mark | null): [number, number] | null {
  if (!mark) return null
  const source = getDB(), out: number[] = []
  for (const [i, table] of TIERS.entries()) {
    const m = mark.tiers[i]
    const view = source.prepare(`SELECT coalesce(max(rowid),0) AS max,count(*) FILTER (WHERE rowid<=?) AS below
      FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE})`).get(m.max, Number.MAX_SAFE_INTEGER) as { max: number; below: number }
    const idAt = (rowid: number): string | null => rowid > 0 ? (source.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid) as { id: string } | undefined)?.id ?? null : null
    if (view.max >= m.max) {
      if (view.below !== m.n || idAt(m.max) !== m.idAtMax) return null
      out.push(m.max)
    } else {
      const last = stmt(db, 'SELECT event_id,row FROM body_event_refs WHERE tier=? AND row<=? ORDER BY row DESC LIMIT 1').get(table, view.max) as { event_id: string; row: number } | undefined
      if (last && idAt(last.row) !== last.event_id) return null
      const held = (stmt(db, 'SELECT count(DISTINCT row) AS n FROM body_event_refs WHERE tier=? AND row<=?').get(table, view.max) as { n: number }).n
      const seen = (source.prepare(`SELECT count(*) AS n FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE}) AND ${ONLY_LATEST_PREFIX}`)
        .get(view.max, JSON.stringify(mark.latest)) as { n: number }).n
      if (held !== seen) return null
      out.push(view.max)
    }
  }
  return [out[0], out[1]]
}
/** Shared refs inside `upTo` whose file no longer has the signature they
 *  were verified with, or that carry no verification (missing, failed). */
function unverified(db: Database.Database, upTo: [number, number]): Local[] {
  const out = new Map<string, Local>(), signatures = new Map<string, string>()
  for (const ref of stmt(db, `SELECT event_id,tier,row,verified_desc,verified_file,verified_sig FROM body_event_refs
      WHERE row<=CASE tier WHEN 'events' THEN ? ELSE ? END AND (verified_desc IS NULL OR verified_file IS NOT NULL)`).all(upTo[0], upTo[1]) as Array<{
      event_id: string; tier: Tier; row: number; verified_desc: string | null; verified_file: string | null; verified_sig: string | null }>) {
    let changed = ref.verified_desc === null
    if (!changed && ref.verified_file) {
      let sig = signatures.get(ref.verified_file)
      if (sig === undefined) { sig = fileSignature(ref.verified_file); signatures.set(ref.verified_file, sig) }
      changed = sig !== ref.verified_sig
    }
    if (changed) out.set(ref.event_id, { id: ref.event_id, tier: ref.tier, r: ref.row })
  }
  return [...out.values()]
}
/** The plan of one call under `snapshot` (none: live). With `link`, the
 *  local events are linked into TEMP first, and TEMP keeps nothing else. */
function readPlan(projectDir: string, snapshot: ExportSnapshot | undefined, link: boolean): ReadPlan {
  const db = getIndex(projectDir), source = getDB(), bounds = boundsOf(snapshot), reader = source.readonly
  const latest = latestSnapshots(snapshot), latestIds = latest.map(l => l.id), wanted = new Set(latestIds)
  // One read transaction: another connection's sync lands before or after.
  const { held, upTo, changed } = db.transaction(() => {
    const mark = readMark(db), covered = vouchedFor(db, mark)
    const upTo: [number, number] = covered ? [Math.min(bounds[0], covered[0]), Math.min(bounds[1], covered[1])] : [-1, -1]
    return { held: new Set(covered ? mark!.latest : []), upTo, changed: reader && covered ? unverified(db, upTo) : [] }
  })()
  const local = new Map<string, Local>()
  for (const l of latest) if (!held.has(l.id) && l.r <= upTo[TIERS.indexOf(l.tier)]) local.set(l.id, l)
  for (const c of changed) local.set(c.id, c)
  for (const [i, table] of TIERS.entries()) {
    if (bounds[i] <= Math.max(upTo[i], 0)) continue
    for (const row of source.prepare(`SELECT id,rowid AS r FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND rowid>? AND (${BODY_SOURCE_PREDICATE})
        AND ${ONLY_LATEST_PREFIX}`).all(bounds[i], Math.max(upTo[i], 0), JSON.stringify(latestIds)) as Array<{ id: string; r: number }>)
      local.set(row.id, { id: row.id, tier: table, r: row.r })
  }
  if (link && (local.size || hasExtraTables(db))) {
    ensureExtraTables(db)
    db.transaction(() => {
      for (const { event_id } of stmt(db, 'SELECT DISTINCT event_id FROM body_x_refs').all() as { event_id: string }[]) if (!local.has(event_id)) dropExtra(db, event_id)
      const linked = stmt(db, 'SELECT status,verified_desc,verified_file,verified_sig FROM body_x_refs WHERE event_id=?')
      for (const l of local.values()) {
        // Linked by an earlier call and still verified: no source row is read.
        const refs = linked.all(l.id) as Array<{ status: string; verified_desc: string | null; verified_file: string | null; verified_sig: string | null }>
        if (refs.length && refs.every(r => r.verified_desc !== null && FINAL_STATUSES.has(r.status) && (r.verified_file === null || fileSignature(r.verified_file) === r.verified_sig))) continue
        const row = source.prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${l.tier} WHERE rowid=?`).get(l.r) as ContentRow | undefined
        if (row) linkRow(row, projectDir, l.tier, EXTRA)
      }
    })()
  }
  const skip = new Set([...held].filter(id => !wanted.has(id)))
  for (const id of local.keys()) skip.add(id)
  return { upTo, local: [...local.values()], skip: [...skip] }
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
  if (readOnlySource()) return
  const db = getIndex(projectDir)
  db.transaction(() => {
    for (const row of stmt(db, 'SELECT ref,raw_docs,decoded_docs FROM body_event_refs WHERE sha256=?').all(sha256) as RefDocs[]) dropDocs(db, row)
    stmt(db, 'DELETE FROM body_event_refs WHERE sha256=?').run(sha256)
    // Nor may this connection's TEMP tables answer for the file.
    if (hasExtraTables(db)) for (const { event_id } of stmt(db, 'SELECT DISTINCT event_id FROM body_x_refs WHERE sha256=?').all(sha256) as { event_id: string }[]) dropExtra(db, event_id)
    // A full walk after a prune puts the ref back as it now is (usually
    // 'missing'); an incremental one would not look at it.
    forgetMark(db)
  })()
}
/** Retention must remove derived raw text together with its saved file. */
export function pruneSavedFileIndex(file:string, projectDir=getProjectDir()):void {
  if(readOnlySource()||!existsSync(path.join(projectDir,'http-body-index.db')))return
  const db=getIndex(projectDir),absolute=path.resolve(file)
  const refs=db.prepare("SELECT ref,raw_docs,decoded_docs,file FROM body_event_refs WHERE kind<>'body'").all() as Array<RefDocs&{file:string}>
  db.transaction(()=>{for(const ref of refs)if(path.resolve(projectDir,ref.file)===absolute){
    dropDocs(db,ref)
    db.prepare('DELETE FROM body_event_refs WHERE ref=?').run(ref.ref)
  }
  if(hasExtraTables(db))for(const ref of stmt(db,"SELECT DISTINCT event_id,file FROM body_x_refs WHERE kind<>'body'").all() as {event_id:string;file:string}[])
    if(path.resolve(projectDir,ref.file)===absolute)dropExtra(db,ref.event_id)
  forgetMark(db)})()
}
/** A raw snapshot spans its Session prefix, not individual target/time/tool rows.
 *  Hidden non-work traffic is not among them: it is on by default, and raw
 *  transcripts are searched whatever it says, as recordings are (decision
 *  2026-11-15 §3), at the cost that non-work text in a conversation can show. */
export function rawTranscriptFiltersUnsupported(conditions: readonly {field:string}[], filter?: {
  targetId?:unknown;since?:unknown;before?:unknown;inScopeOnly?:unknown;tier?:unknown
}): boolean {
  return conditions.some(c=>['tool','transcript','event','operator','source'].includes(c.field)) || Boolean(filter &&
    (filter.targetId || filter.since != null || filter.before != null || filter.inScopeOnly || filter.tier))
}
/** For each term of `query` (as ftsTerms quotes it: a phrase, the last one a
 *  prefix), the events that have a body document containing it. A term is
 *  matched within one document; different terms may sit in different
 *  documents or bodies of an event, or in the event's own data (the caller
 *  combines these with the events index per term). Each list holds only
 *  events of rows inside `snapshot` (or the whole project) as this
 *  connection sees them, with the transcript prefix latest there, also while
 *  another connection holds the index. */
export function searchHttpBodyTermIds(query: string, projectDir = getProjectDir(), excludeAiRaw = false,snapshot?:ExportSnapshot): Array<{ term: string; eventIds: string[] }> {
  const terms = ftsTerms(query)
  if (!terms.length)
    return []
  // Another writer held the index past the busy timeout: this call reads the
  // rows the watermark does not cover from TEMP instead (readPlan).
  if (!getDB().readonly) {
    try { sync(projectDir) }
    catch (error) { if (!(error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY'))) throw error }
  }
  const db = getIndex(projectDir), plan = readPlan(projectDir, snapshot, true)
  const kind = excludeAiRaw ? " AND r.kind<>'ai-raw'" : ''
  // Failed references have already lost their FTS rows. Report them through
  // coverage without withholding unrelated, verified matches. A document's
  // ref is its rowid / REF_SPAN, an integer primary key lookup: shared
  // documents in shared refs, this connection's TEMP documents in its TEMP
  // refs, whose ids are its own.
  const find = stmt(db, `SELECT DISTINCT r.event_id FROM body_fts JOIN body_event_refs r ON r.ref=body_fts.rowid/${REF_SPAN} WHERE body_fts MATCH @term
      AND r.row<=CASE r.tier WHEN 'events' THEN @chained ELSE @logged END${kind}
      AND r.event_id NOT IN (SELECT value FROM json_each(@skip))`)
  const findLocal = plan.local.length ? stmt(db, `SELECT DISTINCT r.event_id FROM body_x_fts JOIN body_x_refs r ON r.ref=body_x_fts.rowid/${REF_SPAN}
      WHERE body_x_fts MATCH @term AND r.event_id IN (SELECT value FROM json_each(@local))${kind}`) : null
  const skip = JSON.stringify(plan.skip), local = JSON.stringify(plan.local.map(l => l.id))
  return terms.map(term => {
    const ids = (find.all({ term, chained: plan.upTo[0], logged: plan.upTo[1], skip }) as { event_id: string }[]).map(row => row.event_id)
    if (findLocal) ids.push(...(findLocal.all({ term, local }) as { event_id: string }[]).map(row => row.event_id))
    return { term, eventIds: [...new Set(ids)] }
  })
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
/** Every ref coverage counts, in source order (tier, row, position), under
 *  the same plan a search makes (readPlan, without linking). Refs the shared
 *  index vouches for are read from body_event_refs, local ones from this
 *  connection's TEMP tables; neither reads a source row. A local event TEMP
 *  does not hold is read from its source row, its refs' status looked up in
 *  the shared index (none: pending). */
function coverageEntries(snapshot: ExportSnapshot | undefined, projectId: string | undefined): CoverageEntry[] {
  const projectDir = getProjectDir(), db = getIndex(projectDir), source = getDB()
  const plan = readPlan(projectDir, snapshot, false), skip = new Set(plan.skip)
  type Keyed = { row: number; pos: number; entry: CoverageEntry }
  type RefRow = { event_id: string; kind: IndexedRef['kind']; file: string; sha256: string; size: number; source_bytes: number; status: string; indexed_bytes: number; reason: string; available_bytes: number; row: number; pos: number; engagement_id: string | null }
  const keyed = (r: RefRow): Keyed => ({ row: r.row, pos: r.pos, entry: { eventId: r.event_id, kind: r.kind, file: r.file, sha256: r.sha256, size: r.size,
    sourceBytes: r.source_bytes, pending: r.kind === 'ai-raw' && r.status === 'pending', status: r.status, indexedBytes: r.indexed_bytes, reason: r.reason, availableBytes: r.available_bytes } })
  const COLUMNS = 'event_id,kind,file,sha256,size,source_bytes,status,indexed_bytes,reason,available_bytes,row,pos,engagement_id'
  const lookup = stmt(db, 'SELECT status,indexed_bytes,reason,available_bytes FROM body_event_refs WHERE event_id=? AND slot=?')
  const fromSource = (row: ContentRow): Keyed[] =>
    refsOf({ agentType: row.agent_type, data: JSON.parse(row.data) as Record<string, unknown> }).map((ref, pos) => {
      const indexed = lookup.get(row.id, ref.slot) as { status: string; indexed_bytes: number; reason: string; available_bytes: number } | undefined
      return { row: row.r, pos, entry: { eventId: row.id, kind: ref.kind, file: ref.file, sha256: ref.sha256, size: Number.isSafeInteger(ref.size) ? ref.size : 0,
        sourceBytes: sourceBytesOf(ref), pending: ref.kind !== 'body' && ref.pending === true, status: indexed?.status, indexedBytes: indexed?.indexed_bytes ?? 0,
        reason: indexed?.reason ?? '', availableBytes: indexed?.available_bytes ?? 0 } }
    })
  const fromTemp = plan.local.length && hasExtraTables(db) ? stmt(db, `SELECT ${COLUMNS} FROM body_x_refs WHERE event_id=? ORDER BY pos`) : null
  const indexedRows = stmt(db, `SELECT ${COLUMNS} FROM body_event_refs WHERE tier=@tier AND row<=@upTo AND (@project IS NULL OR engagement_id=@project) ORDER BY row,pos`)
  return db.transaction(() => TIERS.flatMap((table, i) => {
    const shared = (indexedRows.all({ tier: table, upTo: plan.upTo[i], project: projectId ?? null }) as RefRow[]).filter(r => !skip.has(r.event_id)).map(keyed)
    const local = plan.local.filter(l => l.tier === table).flatMap(l => {
      const temp = fromTemp ? fromTemp.all(l.id) as RefRow[] : []
      if (temp.length) return temp.filter(r => !projectId || r.engagement_id === projectId).map(r => keyed({ ...r, row: l.r }))
      const row = source.prepare(`SELECT id,data,agent_type,rowid AS r,engagement_id FROM ${table} WHERE rowid=?`).get(l.r) as ContentRow | undefined
      return row && (!projectId || row.engagement_id === projectId) ? fromSource(row) : []
    })
    const merged = local.length ? [...shared, ...local].sort((a, b) => a.row - b.row || a.pos - b.pos) : shared
    return merged.map(e => e.entry)
  }))()
}
/** A source-scoped manifest, not a claim that every attachment was indexed. */
export function bodySearchCoverage(snapshot?: ExportSnapshot, projectId?: string, options?: {parsed?:ParsedQuery;filter?:EventFilter}): BodySearchCoverage {
  const coverage: BodySearchCoverage = {projectId:projectId??null,boundary:snapshot,revision:'',indexed:0,missing:0,binary:0,limited:0,partial:0,pending:0,failed:0,indexedBytes:0,sourceBytes:0,unsupported:0,sources:[]}
  const applied = [...(options?.parsed?.conditions.map(c=>c.field)??[]),
    ...Object.entries(options?.filter??{}).filter(([,v])=>v!=null&&v!==false&&v!=='').map(([key])=>key)].sort()
  const rawUnsupported = applied.filter(key=>['tool','transcript','event','operator','source','targetId','since','before','inScopeOnly','tier'].includes(key))
  // Said nothing of a raw transcript: neither applied to it nor a reason to
  // leave it out (rawTranscriptFiltersUnsupported).
  const rawIgnored = ['hidePersonal','personalDomains']
  const groups = new Map<string,SearchCoverageSource>()
  const hashes = new Map<string,ReturnType<typeof createHash>>()
  for (const kind of ['events','body','artifact','ai-raw'] as const) {
    const unsupported = kind==='ai-raw'?rawUnsupported:[]
    groups.set(kind,{kind,status:'covered',revision:'',indexed:0,missing:0,binary:0,pending:0,failed:0,unsupported:0,limited:0,partial:0,indexedBytes:0,sourceBytes:0,
      representation:kind==='events'?'decoded-event-json':kind==='ai-raw'?'confirmed-jsonl-prefix':'saved-bytes',precision:kind==='events'?'event':'file',
      filters:{applied:applied.filter(key=>!unsupported.includes(key)&&!(kind==='ai-raw'&&rawIgnored.includes(key))),unsupported}})
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
