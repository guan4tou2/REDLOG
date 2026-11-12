import { BODY_SOURCE_PREDICATE } from './content-contract'
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
/** v8: each ref row knows its source row and carries its own coverage
 *  contribution; `body_coverage` holds the per (project, kind, status) sums,
 *  kept by triggers in the same statement as the row they describe. */
const INDEX_VERSION = 8
/** The two revision lanes are sums of 48-bit row hashes modulo 2^52, which
 *  keeps every intermediate value an exact JavaScript and SQLite integer. */
const LANE = 4503599627370496
let index: Database.Database | null = null, indexDir: string | null = null
const V7_DROP = 'DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state; DROP TABLE IF EXISTS body_index_meta; DROP TABLE IF EXISTS body_coverage; DROP TABLE IF EXISTS body_relink'
const V7_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,event_id UNINDEXED,sha256 UNINDEXED,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE IF NOT EXISTS body_event_refs (
   event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
   status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,
   tier TEXT,verified_desc TEXT,verified_file TEXT,verified_sig TEXT,PRIMARY KEY(event_id,sha256)
  );
  CREATE INDEX IF NOT EXISTS body_event_refs_sha256 ON body_event_refs(sha256);
  CREATE TABLE IF NOT EXISTS body_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`
// What v8 adds to a v7 index. A v7 index is migrated in place, so the bodies
// it already verified and tokenized are not read again.
const V8_COLUMNS = ['engagement_id TEXT', '"row" INTEGER', 'refs INTEGER NOT NULL DEFAULT 1', 'ref_bytes INTEGER NOT NULL DEFAULT 0',
  'c_idx INTEGER NOT NULL DEFAULT 0', 'c_gn INTEGER NOT NULL DEFAULT 0', 'c_gb INTEGER NOT NULL DEFAULT 0', 'h1 INTEGER', 'h2 INTEGER']
const COVERAGE_KEY = (r: 'new' | 'old'): string => `coalesce(${r}.engagement_id,''),${r}.kind,${r}.status`
const V8_SCHEMA = `CREATE INDEX IF NOT EXISTS body_event_refs_position ON body_event_refs(tier,"row");
  CREATE INDEX IF NOT EXISTS body_event_refs_verified ON body_event_refs(verified_sig,verified_file) WHERE verified_file IS NOT NULL;
  CREATE INDEX IF NOT EXISTS body_event_refs_unverified ON body_event_refs(event_id) WHERE verified_desc IS NULL;
  CREATE INDEX IF NOT EXISTS body_event_refs_unplaced ON body_event_refs(event_id) WHERE "row" IS NULL;
  CREATE INDEX IF NOT EXISTS body_event_refs_ai_raw ON body_event_refs(kind) WHERE kind='ai-raw';
  CREATE TABLE IF NOT EXISTS body_relink (event_id TEXT PRIMARY KEY,tier TEXT);
  CREATE TABLE IF NOT EXISTS body_coverage (engagement_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
   rows INTEGER NOT NULL,n INTEGER NOT NULL,src INTEGER NOT NULL,idx INTEGER NOT NULL,gn INTEGER NOT NULL,gb INTEGER NOT NULL,
   h1 INTEGER NOT NULL,h2 INTEGER NOT NULL,PRIMARY KEY(engagement_id,kind,status));
  CREATE TRIGGER IF NOT EXISTS body_coverage_insert AFTER INSERT ON body_event_refs BEGIN ${addRow('new')} END;
  CREATE TRIGGER IF NOT EXISTS body_coverage_delete AFTER DELETE ON body_event_refs BEGIN ${removeRow('old')} END;
  CREATE TRIGGER IF NOT EXISTS body_coverage_update AFTER UPDATE OF engagement_id,kind,status,refs,ref_bytes,c_idx,c_gn,c_gb,h1,h2 ON body_event_refs
   WHEN ${['engagement_id', 'kind', 'status', 'refs', 'ref_bytes', 'c_idx', 'c_gn', 'c_gb', 'h1', 'h2'].map(c => `old.${c} IS NOT new.${c}`).join(' OR ')}
   BEGIN ${removeRow('old')} ${addRow('new')} END;`
function addRow(r: 'new'): string {
  return `INSERT INTO body_coverage VALUES(${COVERAGE_KEY(r)},1,${r}.refs,${r}.ref_bytes,${r}.c_idx,${r}.c_gn,${r}.c_gb,coalesce(${r}.h1,0),coalesce(${r}.h2,0))
    ON CONFLICT(engagement_id,kind,status) DO UPDATE SET rows=rows+1,n=n+excluded.n,src=src+excluded.src,idx=idx+excluded.idx,gn=gn+excluded.gn,gb=gb+excluded.gb,
    h1=(h1+excluded.h1)%${LANE},h2=(h2+excluded.h2)%${LANE};`
}
function removeRow(r: 'old'): string {
  return `UPDATE body_coverage SET rows=rows-1,n=n-${r}.refs,src=src-${r}.ref_bytes,idx=idx-${r}.c_idx,gn=gn-${r}.c_gn,gb=gb-${r}.c_gb,
    h1=(h1-coalesce(${r}.h1,0)+${LANE})%${LANE},h2=(h2-coalesce(${r}.h2,0)+${LANE})%${LANE}
    WHERE engagement_id=coalesce(${r}.engagement_id,'') AND kind=${r}.kind AND status=${r}.status;`
}
function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir)
    return index
  closeHttpBodyIndex()
  const db = new Database(path.join(projectDir, 'http-body-index.db'))
  db.pragma('journal_mode = WAL')
  // The coverage triggers make every ref write a two-table statement, which
  // SQLite backs with a statement journal: a temp file by default, written
  // for every row of a walk. In memory it costs a copy of the pages that one
  // statement touches.
  db.pragma('temp_store = MEMORY')
  // Rebuild or migrate only this disposable index, never a source Event or
  // sidecar. An index already at this version is opened without a write: each
  // commit is a flush, which is what a reopen costs on Windows.
  const version = db.pragma('user_version', { simple: true })
  if (version !== INDEX_VERSION) db.transaction(() => {
    if (version === 7 && db.prepare("SELECT 1 FROM sqlite_master WHERE name='body_event_refs'").get()) {
      for (const column of V8_COLUMNS) db.exec(`ALTER TABLE body_event_refs ADD COLUMN ${column}`)
      // Where every row was walked to belongs to the v7 process that walked it.
      db.exec("DELETE FROM body_index_meta WHERE key<>'directories'")
    } else {
      db.exec(V7_DROP)
      db.exec(V7_SCHEMA)
      for (const column of V8_COLUMNS) db.exec(`ALTER TABLE body_event_refs ADD COLUMN ${column}`)
    }
    db.exec(V8_SCHEMA)
    recount(db)
    db.pragma(`user_version=${INDEX_VERSION}`)
  })()
  db.exec('CREATE TEMP TABLE body_seen(event_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(event_id,sha256))')
  index = db
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
// whose file still has that signature skips the open and the hash. A missing
// ref is verified the same way: its signature is the lstat error, so the file
// coming back is what re-links it. Failed refs carry no verification
// (`verified_desc` NULL): they are retried on every search, as before.
//
// Everything a search trusts is persisted, in the same transaction as the
// rows it describes, so it survives a restart and a rolled-back write takes it
// back with the rows: the verification, the walk watermark (`walk` in
// body_index_meta), the refs a prune removed and that must be linked again
// (body_relink), and the coverage sums (body_coverage, kept by triggers). The
// first search after launch costs what changed while the app was closed.
//
// The relaxation: a search does not notice a saved file whose bytes were
// changed in place without changing its dev, inode, size, mtime or ctime, and
// because the signature is persisted that holds across restarts too: a file
// rewritten that way while the app is closed is never noticed by search. It
// needs a clock or filesystem forged under it. Reading a body for display
// still verifies it every time.
type Tier = 'events' | 'events_logged'
const TIERS = ['events', 'events_logged'] as const
/** Where an Event sits in the source tables. */
interface Position { tier: Tier; row: number; engagement: string }
/** The persisted walk watermark: every content-ref row at or below `max` in
 *  each tier is linked (the prefix holding `n` rows, the one at `max` being
 *  `idAtMax`), restricted to the transcript snapshots in `latest`. Rows above
 *  it may be linked too (ingest links live rows); a bounded read leaves them
 *  out by position. */
interface Walk { tiers: Array<{ n: number; max: number; idAtMax: string | null }>; latest: string[] }
let statements = new Map<string, Database.Statement>()
// Prepared once per index handle, lazily, so a statement is compiled the first
// time a path needs it.
function stmt(db: Database.Database, sql: string): Database.Statement {
  let s = statements.get(sql)
  if (!s) { s = db.prepare(sql); statements.set(sql, s) }
  return s
}
const FINAL_STATUSES = new Set(['indexed', 'binary', 'limited', 'pending', 'missing'])
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
type IndexedRef = (BodyRef & {kind:'body';inline?:string}) | (SavedFileRef & {kind:'artifact'|'ai-raw';encoding:'text'})
// Resolve after module initialization: artifact -> events -> body-store is a cycle.
function inlineBodyFields():string[]{return BODY_REF_FIELDS.filter(field=>field.endsWith('_body_ref')).map(field=>field.slice(0,-4))}
function refsOf(event: {agentType?:string;data:Record<string,unknown>}): IndexedRef[] {
  return [
    ...BODY_REF_FIELDS.flatMap(field => {
      const value = event.data[field]
      return value && typeof value === 'object' && typeof (value as BodyRef).sha256 === 'string' && typeof (value as BodyRef).file === 'string'
        ? [{sha256:(value as BodyRef).sha256,file:(value as BodyRef).file,size:(value as BodyRef).size,
          encoding:(value as BodyRef).encoding,truncated:(value as BodyRef).truncated,kind:'body' as const}] : []
    }),
    ...inlineBodyFields().flatMap(field=>{
      const value=event.data[field] as {data?:unknown;encoding?:unknown}|undefined
      if(event.data[`${field}_ref`]||value?.encoding!=='base64'||typeof value.data!=='string')return []
      return [{kind:'body' as const,file:`inline:${field}`,sha256:createHash('sha256').update(value.data).digest('hex'),
        size:Buffer.byteLength(value.data,'base64'),encoding:'base64' as const,inline:value.data}]
    }),
    ...savedFileRefs(event).map(ref=>({...ref,kind:ref.field==='artifact'?'artifact' as const:'ai-raw' as const,encoding:'text' as const}))
  ]
}
/** The bytes a ref says it has, as coverage counts them. */
const refBytes = (ref: IndexedRef): number => Number.isSafeInteger(ref.size) && ref.size >= 0 ? ref.size : 0
/** What one row adds to the coverage sums: one count per ref of the Event that
 *  names this body (a request and response with the same bytes are two), and a
 *  multiset hash of everything the per-ref revision used to hash. */
function contribution(row: { event_id: string; sha256: string; kind: string; file: string; size: number; status: string; reason: string; indexed_bytes: number; available_bytes: number }, sizes: number[]) {
  let c_idx = 0, c_gn = 0, c_gb = 0
  for (const bytes of sizes) {
    c_idx += row.indexed_bytes
    if (row.kind === 'ai-raw' && row.status === 'indexed' && row.available_bytes > bytes) { c_gn++; c_gb += row.available_bytes - bytes }
  }
  const d = createHash('sha256').update(JSON.stringify([row.event_id, row.sha256, row.kind, row.file, row.size, row.status, row.reason, row.indexed_bytes, row.available_bytes, sizes])).digest()
  return { refs: sizes.length, ref_bytes: sizes.reduce((a, b) => a + b, 0), c_idx, c_gn, c_gb, h1: d.readUIntBE(0, 6), h2: d.readUIntBE(6, 6) }
}
/** Where an Event linked from outside a walk sits, if it is stored. */
function locate(id: string): Position | null {
  for (const tier of TIERS) {
    const row = getDB().prepare(`SELECT rowid AS r,engagement_id AS e FROM ${tier} WHERE id=?`).get(id) as { r: number; e: string } | undefined
    if (row) return { tier, row: row.r, engagement: row.e }
  }
  return null
}
export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir = getProjectDir()): void {
  getIndex(projectDir)
  linkEvent(event, projectDir, locate(event.id))
}
type PriorRow = { status: string; indexed_bytes: number; reason: string; available_bytes: number; file: string; size: number; kind: string
  tier: Tier | null; row: number | null; engagement_id: string | null; refs: number; ref_bytes: number; h1: number | null
  verified_desc: string | null; verified_file: string | null; verified_sig: string | null }
/** Link every body an Event names; returns the sha256 of each. */
function linkEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir: string, position: Position | null): string[] {
  const db = getIndex(projectDir)
  // One row per (Event, body): refs naming the same bytes share it.
  const groups = new Map<string, { ref: IndexedRef; sizes: number[] }>()
  for (const ref of refsOf(event)) {
    const group = groups.get(ref.sha256)
    if (group) group.sizes.push(refBytes(ref)); else groups.set(ref.sha256, { ref, sizes: [refBytes(ref)] })
  }
  // Inside a walk's transaction a savepoint per event buys nothing: any error
  // aborts the whole walk anyway.
  const atomic = (run: () => void): void => { if (db.inTransaction) run(); else db.transaction(run)() }
  atomic(() => {
    for (const { ref, sizes } of groups.values()) {
      let status = 'indexed', bytes = 0, reason = '',availableBytes=0
      const prior = stmt(db, 'SELECT status,indexed_bytes,reason,available_bytes,file,size,kind,tier,"row",engagement_id,refs,ref_bytes,h1,verified_desc,verified_file,verified_sig FROM body_event_refs WHERE event_id=? AND sha256=?').get(event.id, ref.sha256) as PriorRow | undefined
      const file = refFile(ref, projectDir)
      const desc = JSON.stringify([ref.file, ref.size, ref.encoding ?? null, ref.kind, ref.kind !== 'body' && ref.pending === true, ref.kind === 'body' && ref.inline !== undefined])
      // Nothing that decides this row has changed since it was verified.
      if (prior && prior.verified_desc === desc && FINAL_STATUSES.has(prior.status)
        && (prior.verified_file === null || (prior.verified_file === file && fileSignature(prior.verified_file) === prior.verified_sig))) {
        if (position && (prior.tier !== position.tier || prior.row !== position.row || prior.engagement_id !== position.engagement))
          stmt(db, 'UPDATE body_event_refs SET tier=?,"row"=?,engagement_id=? WHERE event_id=? AND sha256=?').run(position.tier, position.row, position.engagement, event.id, ref.sha256)
        const c = contribution({ ...prior, event_id: event.id, sha256: ref.sha256 }, sizes)
        // A row from a v7 index, or one whose Event names the body more times.
        if (prior.h1 === null || prior.refs !== c.refs || prior.ref_bytes !== c.ref_bytes)
          stmt(db, 'UPDATE body_event_refs SET refs=?,ref_bytes=?,c_idx=?,c_gn=?,c_gb=?,h1=?,h2=? WHERE event_id=? AND sha256=?').run(c.refs, c.ref_bytes, c.c_idx, c.c_gn, c.c_gb, c.h1, c.h2, event.id, ref.sha256)
        continue
      }
      // Taken before reading: a change while reading leaves a stale signature,
      // which only causes one more verification next time.
      const sig = file === null ? null : fileSignature(file)
      try {
        const read = (use: (source:ByteSource)=>void):void => {
          if(ref.kind==='body'&&ref.inline!==undefined)withInlineBase64(ref.inline,use)
          else if(ref.kind==='body') withVerifiedBody(ref,use,projectDir)
          else withVerifiedSavedFile(ref,use,projectDir)
        }
        if(ref.kind!=='body'&&ref.pending)status='pending'
        else read(source => {
          availableBytes=source.availableBytes??source.bytes
          if (source.format === 'binary') {
            status = 'binary'
            reason = 'binary'
            return
          }
          bytes = source.bytes
          if (prior?.status === 'indexed') return
          // event_id is UNINDEXED in FTS5, so this delete reads every indexed
          // chunk. A pair with no ref row has no FTS rows (both are written in
          // this transaction and removed together), so a new body skips it.
          if (prior) stmt(db, 'DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
          const insert = stmt(db, 'INSERT INTO body_fts(content,event_id,sha256) VALUES(?,?,?)')
          const decoder = new TextDecoder('utf-8', { fatal: true })
          let text = '', skippingToken = false
          const separator = /[^\p{L}\p{N}\p{Co}\p{M}]/u
          const write = (part: string): void => { if(part) insert.run(part,event.id,ref.sha256) }
          const consume = (part: string, final = false): void => {
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
          for (let off = 0; off < source.bytes; off += INDEX_CHUNK_BYTES)
            consume(decoder.decode(source.read(off, Math.min(INDEX_CHUNK_BYTES, source.bytes - off)), {stream:true}))
          consume(decoder.decode(),true)
        })
      }
      catch (error) {
        bytes = 0
        status = error instanceof ContentAccessError && error.status === 'missing' ? 'missing' : error instanceof ContentAccessError && error.status==='unsupported'?'limited':'failed'
        reason = error instanceof ContentAccessError ? error.status : 'failed'
      }
      if (status !== 'indexed' && prior)
        stmt(db, 'DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
      // pending/limited come from the event alone; indexed/binary/missing from
      // a file whose signature is recorded (for missing, the lstat error), so
      // a restored file is re-linked. failed can change with no new row and no
      // new signature (a transient read error), so it carries no verification
      // and is retried every search.
      const final = FINAL_STATUSES.has(status)
      const size = Number.isSafeInteger(ref.size) ? ref.size : 0, encoding = String(ref.encoding ?? 'unknown')
      const c = contribution({ event_id: event.id, sha256: ref.sha256, kind: ref.kind, file: ref.file, size, status, reason, indexed_bytes: bytes, available_bytes: availableBytes }, sizes)
      stmt(db, `INSERT INTO body_event_refs(event_id,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,tier,verified_desc,verified_file,verified_sig,
      engagement_id,"row",refs,ref_bytes,c_idx,c_gn,c_gb,h1,h2) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,sha256) DO UPDATE SET
    file=excluded.file,size=excluded.size,encoding=excluded.encoding,status=excluded.status,indexed_bytes=excluded.indexed_bytes,reason=excluded.reason,kind=excluded.kind,available_bytes=excluded.available_bytes,
    tier=coalesce(excluded.tier,body_event_refs.tier),verified_desc=excluded.verified_desc,verified_file=excluded.verified_file,verified_sig=excluded.verified_sig,
    engagement_id=coalesce(excluded.engagement_id,body_event_refs.engagement_id),"row"=coalesce(excluded."row",body_event_refs."row"),
    refs=excluded.refs,ref_bytes=excluded.ref_bytes,c_idx=excluded.c_idx,c_gn=excluded.c_gn,c_gb=excluded.c_gb,h1=excluded.h1,h2=excluded.h2`).run(
        event.id, ref.sha256, ref.file, size, encoding, status, bytes, reason, ref.kind, availableBytes,
        position?.tier ?? null, final ? desc : null, final && status !== 'pending' ? file : null, final && status !== 'pending' ? sig : null,
        position?.engagement ?? null, position?.row ?? null, c.refs, c.ref_bytes, c.c_idx, c.c_gn, c.c_gb, c.h1, c.h2)
    }
  })
  return [...groups.keys()]
}
function latestSnapshotIds(snapshot?: Pick<ExportSnapshot, 'chainedMaxRowId' | 'loggedMaxRowId'>): string[] {
  // A snapshot is a cumulative prefix of one saved file. Index the latest
  // confirmed version inside this dataset, rather than copying every prefix.
  return (getDB().prepare(`WITH versions AS (
    SELECT id,engagement_id,created_at,rowid AS r,1 AS tier,json_extract(data,'$.snapshot_path') AS file FROM events
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    UNION ALL SELECT id,engagement_id,created_at,rowid,0,json_extract(data,'$.snapshot_path') FROM events_logged
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    ), ranked AS (SELECT id,row_number() OVER(PARTITION BY engagement_id,file ORDER BY created_at DESC,r DESC,tier DESC,id) AS n FROM versions)
    SELECT id FROM ranked WHERE n=1`).all(snapshot?.chainedMaxRowId??Number.MAX_SAFE_INTEGER,snapshot?.loggedMaxRowId??Number.MAX_SAFE_INTEGER) as {id:string}[]).map(row=>row.id).sort()
}
type SourceRow = { id: string; data: string; agent_type: string; engagement_id: string; r: number }
/** Content-ref rows of both tiers with `after < rowid <= upTo`. */
function rows(latest: string[], range: Array<{ after: number; upTo: number }>): Array<IterableIterator<SourceRow>> {
  const source = getDB()
  return TIERS.map((table, i) => source.prepare(`SELECT id,data,agent_type,engagement_id,rowid AS r FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND rowid>? AND (${BODY_SOURCE_PREDICATE})
      AND (agent_type<>'agent' OR coalesce(subtype,'')<>'transcript_snapshot' OR id IN (SELECT value FROM json_each(?))) ORDER BY rowid`).iterate(range[i].upTo, range[i].after, JSON.stringify(latest)) as IterableIterator<SourceRow>)
}
const linkRow = (row: SourceRow, projectDir: string, tier: Tier): string[] =>
  linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, { tier, row: row.r, engagement: row.engagement_id })
/** One stored Event by tier and id, for a re-link. */
function sourceRow(tier: Tier, id: string): SourceRow | undefined {
  return getDB().prepare(`SELECT id,data,agent_type,engagement_id,rowid AS r FROM ${tier} WHERE id=?`).get(id) as SourceRow | undefined
}
function deleteEventRefs(db: Database.Database, eventId: string): void {
  stmt(db, 'DELETE FROM body_fts WHERE event_id=?').run(eventId)
  stmt(db, 'DELETE FROM body_event_refs WHERE event_id=?').run(eventId)
}
const bound = (snapshot: ExportSnapshot | undefined, i: number): number =>
  snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
/** Bring the index up to what a full walk of the rows inside `snapshot` would
 *  answer, doing work for what changed since the persisted watermark rather
 *  than for every ref:
 *
 *  - rows appended above the watermark are linked, and an index row in that
 *    range whose source row is gone (or now holds another Event) is removed;
 *  - a transcript snapshot superseded since is removed by id;
 *  - refs a prune removed are linked again (body_relink);
 *  - files behind remembered refs are re-checked by lstat, and failed refs
 *    retried (`recheck`).
 *
 *  A bounded read below the watermark leaves the rows above its boundary out
 *  by position, so paging an older snapshot does not undo the index.
 *
 *  Anything else (a row deleted inside the walked prefix, an older transcript
 *  snapshot that became latest, a replaced directory, no watermark yet): the
 *  full walk and prune, which is still cheap per ref for every file that has
 *  not changed.
 *
 *  Every content-ref row is inserted with a higher rowid than every row
 *  already there while the highest one survives, and source rows are never
 *  updated, so "the row at the old watermark still has its id, and the count
 *  at or below it is unchanged" means the walked prefix is untouched. */
function sync(projectDir: string, snapshot?: ExportSnapshot, verify = true): void {
  const db = getIndex(projectDir), source = getDB()
  // Persisted with the verifications it vouches for, so a directory replaced
  // while the app was closed is noticed at the next search too.
  const dirs = directorySignature(projectDir)
  const directoriesChanged = (stmt(db, "SELECT value FROM body_index_meta WHERE key='directories'").get() as { value: string } | undefined)?.value !== dirs
  const stored = stmt(db, "SELECT value FROM body_index_meta WHERE key='walk'").get() as { value: string } | undefined
  const previous = directoriesChanged || !stored ? null : JSON.parse(stored.value) as Walk
  const idAt = (table: Tier, rowid: number): string | null => rowid > 0 ? (source.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid) as { id: string } | undefined)?.id ?? null : null
  const tiers = TIERS.map((table, i) => {
    const before = previous?.tiers[i] ?? { n: 0, max: 0, idAtMax: null }, upTo = bound(snapshot, i)
    const row = source.prepare(`SELECT count(*) FILTER (WHERE rowid<=?) AS below,count(*) FILTER (WHERE rowid<=?) AS n,coalesce(max(rowid) FILTER (WHERE rowid<=?),0) AS max
      FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? AND (${BODY_SOURCE_PREDICATE})`).get(before.max, upTo, upTo, Math.max(before.max, upTo)) as { below: number; n: number; max: number }
    const intact = !!previous && row.below === before.n && idAt(table, before.max) === before.idAtMax
    // The watermark only rises: a bounded read below it filters by position.
    const grows = row.max > before.max
    // Read again unless the prefix is intact at the same row: a full walk after
    // a broken prefix must not persist the stale id and walk every time after.
    const inside = { n: row.n, max: row.max, idAtMax: intact && row.max === before.max ? before.idAtMax : idAt(table, row.max) }
    return { table, intact, after: before.max, inside, next: grows ? inside : before }
  })
  const latestInside = latestSnapshotIds(snapshot)
  const below = tiers.some((t, i) => t.next.max > bound(snapshot, i))
  // The transcript snapshots the whole watermark admits; a bounded read sees
  // the ones at or below its own boundary.
  const latest = below ? latestSnapshotIds({ chainedMaxRowId: tiers[0].next.max, loggedMaxRowId: tiers[1].next.max }) : latestInside
  db.transaction(() => {
    if (directoriesChanged) {
      stmt(db, 'UPDATE body_event_refs SET verified_desc=NULL,verified_file=NULL,verified_sig=NULL').run()
      stmt(db, "INSERT INTO body_index_meta VALUES('directories',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(dirs)
    }
    let full = !previous || tiers.some(t => !t.intact)
    if (!full) {
      const before = new Set(previous!.latest), now = new Set(latest)
      const added = latest.filter(id => !before.has(id))
      // A newly latest snapshot inside the walked prefix: an older version
      // became latest again, which only a full walk puts back.
      const placed = (ids: string[]): Map<string, Position> => {
        const found = new Map<string, Position>()
        for (const [i, table] of TIERS.entries()) for (const row of source.prepare(`SELECT id,rowid AS r,engagement_id AS e FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Array<{ id: string; r: number; e: string }>)
          found.set(row.id, { tier: TIERS[i], row: row.r, engagement: row.e })
        return found
      }
      const addedAt = placed(added)
      if ([...addedAt.values()].some(p => p.row <= tiers[TIERS.indexOf(p.tier)].after)) full = true
      // What a bounded read sees of the watermark's snapshots must be what
      // that boundary's own walk would link.
      if (!full && below) {
        const at = placed(latest)
        const visible = latest.filter(id => { const p = at.get(id); return p && p.row <= bound(snapshot, TIERS.indexOf(p.tier)) })
        if (JSON.stringify(visible) !== JSON.stringify(latestInside)) full = true
      }
      if (!full) {
        for (const id of previous!.latest) if (!now.has(id)) deleteEventRefs(db, id)
        place(db)
        stmt(db, 'DELETE FROM body_seen').run()
        const seen = stmt(db, 'INSERT OR IGNORE INTO body_seen VALUES(?,?)')
        for (const [i, tier] of rows(latest, tiers.map(t => ({ after: t.after, upTo: t.next.max }))).entries())
          for (const row of tier) for (const sha256 of linkRow(row, projectDir, TIERS[i])) seen.run(row.id, sha256)
        // Linked above the old watermark (by ingest) but not a row the walk
        // reached: deleted since, or the rowid now holds another Event.
        for (const t of tiers) if (t.next.max > t.after) {
          const stale = stmt(db, `SELECT DISTINCT event_id FROM body_event_refs r WHERE tier=? AND "row">? AND "row"<=?
            AND NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=r.event_id AND s.sha256=r.sha256)`).all(t.table, t.after, t.next.max) as Array<{ event_id: string }>
          for (const { event_id } of stale) deleteEventRefs(db, event_id)
        }
        relink(db, projectDir, latest, tiers.map(t => t.next.max))
        if (verify) recheck(db, projectDir)
      }
    }
    let walk: Walk
    if (full) {
      walkAll(db, projectDir, latestInside, tiers.map(t => ({ after: 0, upTo: t.inside.max })))
      walk = { tiers: tiers.map(t => t.inside), latest: latestInside }
    } else walk = { tiers: tiers.map(t => t.next), latest }
    const value = JSON.stringify(walk)
    if (stored?.value !== value) stmt(db, "INSERT INTO body_index_meta VALUES('walk',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value)
  })()
}
/** Rows ingest linked before their Event's position was known. */
function place(db: Database.Database): void {
  for (const { event_id } of stmt(db, 'SELECT DISTINCT event_id FROM body_event_refs WHERE "row" IS NULL').all() as Array<{ event_id: string }>) {
    const at = locate(event_id)
    if (at) stmt(db, 'UPDATE body_event_refs SET tier=?,"row"=?,engagement_id=? WHERE event_id=?').run(at.tier, at.row, at.engagement, event_id)
    else deleteEventRefs(db, event_id)
  }
}
/** Link again the Events whose refs a prune removed. */
function relink(db: Database.Database, projectDir: string, latest: string[], walked: number[]): void {
  const queued = stmt(db, 'SELECT event_id,tier FROM body_relink').all() as Array<{ event_id: string; tier: Tier | null }>
  if (!queued.length) return
  const snapshots = new Set(latest)
  for (const { event_id, tier } of queued) {
    const at = tier ?? locate(event_id)?.tier
    const row = at && sourceRow(at, event_id)
    if (!at || !row) continue
    // A superseded transcript snapshot inside the watermark stays out.
    if (row.agent_type === 'agent' && row.r <= walked[TIERS.indexOf(at)] && !snapshots.has(row.id)
      && (JSON.parse(row.data) as { subtype?: unknown }).subtype === 'transcript_snapshot') continue
    linkRow(row, projectDir, at)
  }
  stmt(db, 'DELETE FROM body_relink').run()
}
function walkAll(db: Database.Database, projectDir: string, latest: string[], range: Array<{ after: number; upTo: number }>): void {
  stmt(db, 'DELETE FROM body_seen').run()
  const seen = stmt(db, 'INSERT OR IGNORE INTO body_seen VALUES(?,?)')
  for (const [i, tier] of rows(latest, range).entries())
    for (const row of tier) for (const sha256 of linkRow(row, projectDir, TIERS[i])) seen.run(row.id, sha256)
  // The verification lives in the row, so a pruned ref takes it along.
  stmt(db, 'DELETE FROM body_event_refs WHERE NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=body_event_refs.event_id AND s.sha256=body_event_refs.sha256)').run()
  stmt(db, "DELETE FROM body_fts WHERE NOT EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=body_fts.event_id AND r.sha256=body_fts.sha256 AND r.status='indexed')").run()
  stmt(db, 'DELETE FROM body_relink').run()
}
/** Without a walk: re-link the Events whose saved file no longer has the
 *  signature it was verified with (one lstat per distinct file), and every
 *  ref still failed. A ref whose source row is gone is removed. */
function recheck(db: Database.Database, projectDir: string): void {
  const events = new Map<string, Tier | null>(), signatures = new Map<string, string>()
  for (const { file, sig } of stmt(db, 'SELECT verified_file AS file,verified_sig AS sig FROM body_event_refs WHERE verified_file IS NOT NULL GROUP BY verified_sig,verified_file')
    .all() as Array<{ file: string; sig: string }>) {
    let now = signatures.get(file)
    if (now === undefined) { now = fileSignature(file); signatures.set(file, now) }
    if (now !== sig) for (const ref of stmt(db, 'SELECT event_id,tier FROM body_event_refs WHERE verified_file=? AND verified_sig=?').all(file, sig) as Array<{ event_id: string; tier: Tier | null }>)
      events.set(ref.event_id, ref.tier)
  }
  for (const ref of stmt(db, 'SELECT event_id,tier FROM body_event_refs WHERE verified_desc IS NULL').all() as Array<{ event_id: string; tier: Tier | null }>)
    events.set(ref.event_id, ref.tier)
  for (const [eventId, tier] of events) {
    const row = tier && sourceRow(tier, eventId)
    if (!tier || !row) deleteEventRefs(db, eventId)
    else linkRow(row, projectDir, tier)
  }
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
  // The next search links these Events again and puts the ref back as it now
  // is (usually 'missing'); the queue is persisted with the delete.
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO body_relink SELECT event_id,tier FROM body_event_refs WHERE sha256=?').run(sha256)
    db.prepare('DELETE FROM body_fts WHERE sha256=?').run(sha256); db.prepare('DELETE FROM body_event_refs WHERE sha256=?').run(sha256)
  })()
}
/** Retention must remove derived raw text together with its saved file. */
export function pruneSavedFileIndex(file:string, projectDir=getProjectDir()):void {
  if(!existsSync(path.join(projectDir,'http-body-index.db')))return
  const db=getIndex(projectDir),absolute=path.resolve(file)
  const refs=db.prepare("SELECT event_id,sha256,file,tier FROM body_event_refs WHERE kind<>'body'").all() as {event_id:string;sha256:string;file:string;tier:Tier|null}[]
  db.transaction(()=>{for(const ref of refs)if(path.resolve(projectDir,ref.file)===absolute){
    db.prepare('INSERT OR IGNORE INTO body_relink VALUES(?,?)').run(ref.event_id,ref.tier)
    db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(ref.event_id,ref.sha256)
    db.prepare('DELETE FROM body_event_refs WHERE event_id=? AND sha256=?').run(ref.event_id,ref.sha256)
  }})()
}
/** A raw snapshot spans its Session prefix, not individual target/time/tool rows. */
export function rawTranscriptFiltersUnsupported(conditions: readonly {field:string}[], filter?: {
  targetId?:unknown;since?:unknown;before?:unknown;inScopeOnly?:unknown;hidePersonal?:unknown;tier?:unknown
}): boolean {
  return conditions.some(c=>['tool','transcript','event','operator','source'].includes(c.field)) || Boolean(filter &&
    (filter.targetId || filter.since != null || filter.before != null || filter.inScopeOnly || filter.hidePersonal || filter.tier))
}
/** A ref row inside a snapshot's boundary, over the alias `r`. */
const WITHIN = `((r.tier='events' AND r."row"<=?) OR (r.tier='events_logged' AND r."row"<=?))`
export function searchHttpBodyEventIds(query: string, projectDir = getProjectDir(), excludeAiRaw = false,snapshot?:ExportSnapshot): string[] {
  const match = toFtsMatch(query)
  if (!match)
    return []
  sync(projectDir,snapshot)
  const db = getIndex(projectDir)
  // Failed references have already lost their FTS rows. Report them through
  // coverage without withholding unrelated, verified matches.
  // AND remains scoped to one saved body even when its terms occur in
  // different chunks. A term must never be assembled across unrelated refs.
  const terms = ftsTerms(query)
  const where = [excludeAiRaw ? "r.kind<>'ai-raw'" : '', snapshot ? WITHIN : ''].filter(Boolean)
  let matches: Map<string, string> | undefined
  for (const quoted of terms) {
    const rows = db.prepare(`SELECT DISTINCT event_id,sha256 FROM body_fts WHERE body_fts MATCH ?
      ${where.length ? `AND EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=body_fts.event_id AND r.sha256=body_fts.sha256 AND ${where.join(' AND ')})` : ''}`)
      .all(quoted, ...(snapshot ? [snapshot.chainedMaxRowId, snapshot.loggedMaxRowId] : [])) as {event_id:string;sha256:string}[]
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
  indexed: number; missing: number; binary: number; pending: number; failed: number; unsupported: number; limited:number
  indexedBytes: number; sourceBytes: number
  representation: 'decoded-event-json' | 'saved-bytes' | 'confirmed-jsonl-prefix'
  precision: 'event' | 'file'
  filters: {applied:string[];unsupported:string[]}
}
type Sums = { rows: number; n: number; src: number; idx: number; gn: number; gb: number; h1: number; h2: number }
type CoverageRow = { engagement_id: string | null; kind: string; status: string; refs: number; ref_bytes: number; c_idx: number; c_gn: number; c_gb: number; h1: number | null; h2: number | null }
const COVERAGE_COLUMNS = 'engagement_id,kind,status,refs,ref_bytes,c_idx,c_gn,c_gb,h1,h2'
function addTo(sums: Map<string, Sums>, key: string, row: CoverageRow, sign: 1 | -1): void {
  const s = sums.get(key) ?? { rows: 0, n: 0, src: 0, idx: 0, gn: 0, gb: 0, h1: 0, h2: 0 }
  s.rows += sign; s.n += sign * row.refs; s.src += sign * row.ref_bytes; s.idx += sign * row.c_idx; s.gn += sign * row.c_gn; s.gb += sign * row.c_gb
  s.h1 = (s.h1 + sign * (row.h1 ?? 0) + LANE) % LANE; s.h2 = (s.h2 + sign * (row.h2 ?? 0) + LANE) % LANE
  sums.set(key, s)
}
/** Rebuild the coverage sums from the rows. Only a fallback: the triggers keep
 *  them in step with every write. */
function recount(db: Database.Database): void {
  const sums = new Map<string, Sums>()
  for (const row of db.prepare(`SELECT ${COVERAGE_COLUMNS} FROM body_event_refs`).iterate() as IterableIterator<CoverageRow>)
    addTo(sums, JSON.stringify([row.engagement_id ?? '', row.kind, row.status]), row, 1)
  db.prepare('DELETE FROM body_coverage').run()
  const insert = db.prepare('INSERT INTO body_coverage VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  for (const [key, s] of sums) insert.run(...(JSON.parse(key) as string[]), s.rows, s.n, s.src, s.idx, s.gn, s.gb, s.h1, s.h2)
}
/** The persisted sums, after a cheap check that they still describe the
 *  rows: the row counts must agree and nothing may be negative. A sum that
 *  fails it is recounted from the rows, never used. */
function coverageSums(db: Database.Database, projectId?: string): Map<string, Sums> {
  const check = stmt(db, 'SELECT (SELECT count(*) FROM body_event_refs) AS refs,(SELECT coalesce(sum(rows),0) FROM body_coverage) AS counted,(SELECT count(*) FROM body_coverage WHERE rows<0 OR n<0 OR src<0 OR idx<0 OR gn<0 OR gb<0) AS negative')
  const verdict = check.get() as { refs: number; counted: number; negative: number }
  if (verdict.refs !== verdict.counted || verdict.negative) db.transaction(() => recount(db))()
  const sums = new Map<string, Sums>()
  for (const row of stmt(db, `SELECT kind,status,sum(rows) AS rows,sum(n) AS n,sum(src) AS src,sum(idx) AS idx,sum(gn) AS gn,sum(gb) AS gb,sum(h1)%${LANE} AS h1,sum(h2)%${LANE} AS h2
    FROM body_coverage WHERE (? IS NULL OR engagement_id=?) GROUP BY kind,status`).all(projectId ?? null, projectId ?? null) as Array<Sums & { kind: string; status: string }>)
    sums.set(JSON.stringify([row.kind, row.status]), row)
  return sums
}
/** A source-scoped manifest, not a claim that every attachment was indexed. */
export function bodySearchCoverage(snapshot?: ExportSnapshot, projectId?: string, options?: {parsed?:ParsedQuery;filter?:EventFilter}): BodySearchCoverage {
  const projectDir = getProjectDir()
  // The sums describe the index, so the index is brought to this boundary
  // first; that costs what changed since the last search. The files behind it
  // are re-checked by the search, not again here: coverage reports the
  // verification the search just answered from.
  sync(projectDir, snapshot, false)
  const db = getIndex(projectDir)
  const coverage: BodySearchCoverage = {projectId:projectId??null,boundary:snapshot,revision:'',indexed:0,missing:0,binary:0,limited:0,pending:0,failed:0,indexedBytes:0,sourceBytes:0,unsupported:0,sources:[]}
  const applied = [...(options?.parsed?.conditions.map(c=>c.field)??[]),
    ...Object.entries(options?.filter??{}).filter(([,v])=>v!=null&&v!==false&&v!=='').map(([key])=>key)].sort()
  const rawUnsupported = applied.filter(key=>['tool','transcript','event','operator','source','targetId','since','before','inScopeOnly','hidePersonal','tier'].includes(key))
  const groups = new Map<string,SearchCoverageSource>()
  const hashes = new Map<string,ReturnType<typeof createHash>>()
  for (const kind of ['events','body','artifact','ai-raw'] as const) {
    const unsupported = kind==='ai-raw'?rawUnsupported:[]
    groups.set(kind,{kind,status:'covered',revision:'',indexed:0,missing:0,binary:0,pending:0,failed:0,unsupported:0,limited:0,indexedBytes:0,sourceBytes:0,
      representation:kind==='events'?'decoded-event-json':kind==='ai-raw'?'confirmed-jsonl-prefix':'saved-bytes',precision:kind==='events'?'event':'file',
      filters:{applied:applied.filter(key=>!unsupported.includes(key)),unsupported}})
    hashes.set(kind,createHash('sha256').update('saved-index-v8').update(JSON.stringify([applied,unsupported])))
  }
  const eventGroup=groups.get('events')!,eventHash=hashes.get('events')!
  for(const [table,max] of [['events',snapshot?.chainedMaxRowId],['events_logged',snapshot?.loggedMaxRowId]] as const){
    const row=getDB().prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS tail FROM ${table}
      WHERE rowid<=? ${projectId?'AND engagement_id=?':''}`).get(max??Number.MAX_SAFE_INTEGER,...(projectId?[projectId]:[])) as {n:number;tail:number}
    eventGroup.indexed+=row.n;eventHash.update(JSON.stringify([table,row.n,row.tail]))
  }
  const sums = coverageSums(db, projectId)
  const mine = (row: { engagement_id: string | null }): boolean => !projectId || row.engagement_id === projectId
  const remove = (row: CoverageRow): void => addTo(sums, JSON.stringify([row.kind, row.status]), row, -1)
  // Linked above this boundary: in the index, not in this dataset.
  const outside = (row: { tier: Tier | null; row: number | null }): boolean =>
    !!snapshot && row.tier !== null && row.row !== null && row.row > bound(snapshot, TIERS.indexOf(row.tier))
  if (snapshot) for (const row of stmt(db, `SELECT ${COVERAGE_COLUMNS} FROM body_event_refs r WHERE NOT ${WITHIN}`).all(snapshot.chainedMaxRowId, snapshot.loggedMaxRowId) as CoverageRow[])
    if (mine(row)) remove(row)
  // A capture's pending transcript counts until a confirmed snapshot of the
  // same file is in the dataset.
  const raw = (stmt(db, `SELECT ${COVERAGE_COLUMNS},file,tier,"row" FROM body_event_refs WHERE kind='ai-raw'`).all() as Array<CoverageRow & { file: string; tier: Tier | null; row: number | null }>)
    .filter(row => mine(row) && !outside(row))
  const confirmed = new Set(raw.filter(row => row.status !== 'pending').map(row => path.resolve(projectDir, row.file)))
  for (const row of raw) if (row.status === 'pending' && confirmed.has(path.resolve(projectDir, row.file))) remove(row)
  for (const [key, s] of [...sums].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (s.rows === 0) continue
    const [kind, status] = JSON.parse(key) as [SearchCoverageSource['kind'], string]
    const group = groups.get(kind)
    if (!group) continue
    const excluded = kind === 'ai-raw' && rawUnsupported.length > 0
    const counted = excluded ? 'unsupported' : status
    if (counted==='indexed'||counted==='missing'||counted==='binary'||counted==='pending'||counted==='failed'||counted==='unsupported'||counted==='limited') group[counted] += s.n
    group.sourceBytes += s.src
    if (!excluded) { group.indexedBytes += s.idx; group.pending += s.gn; group.sourceBytes += s.gb }
    hashes.get(kind)!.update(JSON.stringify([status, s.rows, s.n, s.src, s.idx, s.gn, s.gb, s.h1, s.h2]))
  }
  const hash=createHash('sha256')
  for(const group of groups.values()){
    group.status=group.failed?'failed':group.missing?'unavailable':group.pending?(group.indexed?'partial':'pending'):group.unsupported||group.binary||group.limited?(group.indexed?'partial':'unsupported'):'covered'
    group.revision=hashes.get(group.kind)!.digest('hex')
    hash.update(group.revision)
    if(group.kind!=='events') {
      for(const key of ['indexed','missing','binary','pending','failed','limited','indexedBytes','sourceBytes'] as const)coverage[key]+=group[key]
      coverage.unsupported!+=group.unsupported
    }
    coverage.sources!.push(group)
  }
  coverage.revision=hash.digest('hex')
  return coverage
}
