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
let index: Database.Database | null = null, indexDir: string | null = null
function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir)
    return index
  closeHttpBodyIndex()
  index = new Database(path.join(projectDir, 'http-body-index.db'))
  index.pragma('journal_mode = WAL')
  // Rebuild only this disposable index, never a source Event or sidecar.
  // v7 added the verification columns below; an older index is rebuilt once.
  if (index.pragma('user_version', { simple: true }) !== 7)
    index.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state; DROP TABLE IF EXISTS body_index_meta')
  index.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,event_id UNINDEXED,sha256 UNINDEXED,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE IF NOT EXISTS body_event_refs (
   event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
   status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,
   tier TEXT,verified_desc TEXT,verified_file TEXT,verified_sig TEXT,PRIMARY KEY(event_id,sha256)
  );
  CREATE INDEX IF NOT EXISTS body_event_refs_sha256 ON body_event_refs(sha256);
  CREATE TABLE IF NOT EXISTS body_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  PRAGMA user_version=7;
  CREATE TEMP TABLE body_seen(event_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(event_id,sha256));`)
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
const FINAL_STATUSES = new Set(['indexed', 'binary', 'limited', 'pending'])
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
export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir = getProjectDir()): void {
  getIndex(projectDir)
  linkedOutsideWalk.add(event.id)
  linkEvent(event, projectDir, null)
}
function linkEvent(event: Pick<RedLogEvent, 'id' | 'data'> & {agentType?:string}, projectDir: string, tier: Tier | null): void {
  const db = getIndex(projectDir)
  // Inside a walk's transaction a savepoint per event buys nothing: any error
  // aborts the whole walk anyway.
  const atomic = (run: () => void): void => { if (db.inTransaction) run(); else forgetOnError(() => db.transaction(run)()) }
  atomic(() => {
    for (const ref of refsOf(event)) {
      let status = 'indexed', bytes = 0, reason = '',availableBytes=0
      const prior = stmt(db, 'SELECT status,tier,verified_desc,verified_file,verified_sig FROM body_event_refs WHERE event_id=? AND sha256=?').get(event.id, ref.sha256) as {
        status: string; tier: Tier | null; verified_desc: string | null; verified_file: string | null; verified_sig: string | null
      } | undefined
      const file = refFile(ref, projectDir)
      const desc = JSON.stringify([ref.file, ref.size, ref.encoding ?? null, ref.kind, ref.kind !== 'body' && ref.pending === true, ref.kind === 'body' && ref.inline !== undefined])
      // Nothing that decides this row has changed since it was verified.
      if (prior && prior.verified_desc === desc && FINAL_STATUSES.has(prior.status)
        && (prior.verified_file === null || (prior.verified_file === file && fileSignature(prior.verified_file) === prior.verified_sig))) {
        if (tier && prior.tier !== tier) stmt(db, 'UPDATE body_event_refs SET tier=? WHERE event_id=? AND sha256=?').run(tier, event.id, ref.sha256)
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
      // pending/limited come from the event alone; indexed/binary from bytes
      // whose signature is recorded. missing/failed can change with no new
      // row (a file restored or repaired), so they carry no verification and
      // are retried every search.
      const final = FINAL_STATUSES.has(status)
      stmt(db, `INSERT INTO body_event_refs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,sha256) DO UPDATE SET
    file=excluded.file,size=excluded.size,encoding=excluded.encoding,status=excluded.status,indexed_bytes=excluded.indexed_bytes,reason=excluded.reason,kind=excluded.kind,available_bytes=excluded.available_bytes,
    tier=coalesce(excluded.tier,body_event_refs.tier),verified_desc=excluded.verified_desc,verified_file=excluded.verified_file,verified_sig=excluded.verified_sig`).run(event.id, ref.sha256, ref.file, Number.isSafeInteger(ref.size) ? ref.size : 0, String(ref.encoding ?? 'unknown'), status, bytes, reason, ref.kind,availableBytes,
        tier, final ? desc : null, final && status !== 'pending' ? file : null, final && status !== 'pending' ? sig : null)
    }
  })
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
    return source.prepare(`SELECT id,data,agent_type FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? ${range ? 'AND rowid>?' : ''} ${projectId ? 'AND engagement_id=?' : ''} AND (${BODY_SOURCE_PREDICATE})
      AND (agent_type<>'agent' OR coalesce(subtype,'')<>'transcript_snapshot' OR id IN (SELECT value FROM json_each(?))) ORDER BY rowid`).iterate(max, ...(range ? [range[i].after] : []), ...(projectId ? [projectId] : []),JSON.stringify(latest)) as IterableIterator<{
      id: string
      data: string
      agent_type:string
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
  forgetOnError(() => db.transaction(() => {
    if (directoriesChanged) {
      stmt(db, 'UPDATE body_event_refs SET verified_desc=NULL,verified_file=NULL,verified_sig=NULL').run()
      stmt(db, "INSERT INTO body_index_meta VALUES('directories',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(dirs)
    }
    let full = !previous || tiers.some(t => !t.intact)
    if (!full) {
      const seen = new Set<string>()
      for (const [i, tier] of rows(snapshot, undefined, latestIds, tiers.map(t => ({ after: t.after, upTo: t.max }))).entries())
        for (const row of tier) { seen.add(row.id); linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, TIERS[i]) }
      // Ingest linked a row this walk did not reach (outside the boundary):
      // only the full walk's prune removes it.
      full = [...linkedOutsideWalk].some(id => !seen.has(id)) || !recheck(projectDir)
    }
    if (full) walkAll(db, projectDir, snapshot, latestIds, tiers.map(t => ({ after: 0, upTo: t.max })))
  })())
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
      linkEvent({ id: row.id, data, agentType: row.agent_type }, projectDir, TIERS[i])
      for (const ref of refsOf({ data, agentType: row.agent_type })) seen.run(row.id, ref.sha256)
    }
  // The verification lives in the row, so a pruned ref takes it along.
  stmt(db, 'DELETE FROM body_event_refs WHERE NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=body_event_refs.event_id AND s.sha256=body_event_refs.sha256)').run()
  stmt(db, "DELETE FROM body_fts WHERE NOT EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=body_fts.event_id AND r.sha256=body_fts.sha256 AND r.status='indexed')").run()
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
    const row = tier && getDB().prepare(`SELECT id,data,agent_type FROM ${tier} WHERE id=?`).get(eventId) as { id: string; data: string; agent_type: string } | undefined
    if (!tier || !row) return false
    linkEvent({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, agentType: row.agent_type }, projectDir, tier)
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
  db.transaction(() => { db.prepare('DELETE FROM body_fts WHERE sha256=?').run(sha256); db.prepare('DELETE FROM body_event_refs WHERE sha256=?').run(sha256); })()
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
    db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(ref.event_id,ref.sha256)
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
  sync(projectDir,snapshot)
  const db = getIndex(projectDir)
  // Failed references have already lost their FTS rows. Report them through
  // coverage without withholding unrelated, verified matches.
  // AND remains scoped to one saved body even when its terms occur in
  // different chunks. A term must never be assembled across unrelated refs.
  const terms = ftsTerms(query)
  let matches: Map<string, string> | undefined
  for (const quoted of terms) {
    const rows = db.prepare(`SELECT DISTINCT event_id,sha256 FROM body_fts WHERE body_fts MATCH ?
      ${excludeAiRaw ? "AND EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=body_fts.event_id AND r.sha256=body_fts.sha256 AND r.kind<>'ai-raw')" : ''}`).all(quoted) as {event_id:string;sha256:string}[]
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
/** A source-scoped manifest, not a claim that every attachment was indexed. */
export function bodySearchCoverage(snapshot?: ExportSnapshot, projectId?: string, options?: {parsed?:ParsedQuery;filter?:EventFilter}): BodySearchCoverage {
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
    hashes.set(kind,createHash('sha256').update('saved-index-v7').update(JSON.stringify([applied,unsupported])))
  }
  const eventGroup=groups.get('events')!,eventHash=hashes.get('events')!
  for(const [table,max] of [['events',snapshot?.chainedMaxRowId],['events_logged',snapshot?.loggedMaxRowId]] as const){
    const row=getDB().prepare(`SELECT count(*) AS n,coalesce(max(rowid),0) AS tail FROM ${table}
      WHERE rowid<=? ${projectId?'AND engagement_id=?':''}`).get(max??Number.MAX_SAFE_INTEGER,...(projectId?[projectId]:[])) as {n:number;tail:number}
    eventGroup.indexed+=row.n;eventHash.update(JSON.stringify([table,row.n,row.tail]))
  }
  const confirmed = new Set<string>()
  const pending: Array<{ eventId: string; ref: ReturnType<typeof refsOf>[number] }> = []
  let lookup: Database.Statement | undefined
  const record = (eventId: string, ref: ReturnType<typeof refsOf>[number]): void => {
      lookup ??= getIndex().prepare('SELECT status,indexed_bytes,reason,available_bytes FROM body_event_refs WHERE event_id=? AND sha256=?')
      const indexed=lookup.get(eventId,ref.sha256) as {status:string;indexed_bytes:number;reason:string;available_bytes:number}|undefined
      const excluded=ref.kind==='ai-raw'&&rawUnsupported.length>0
      const key=excluded?'unsupported':indexed?.status??'pending'
      const group=groups.get(ref.kind)!
      if(key==='indexed'||key==='missing'||key==='binary'||key==='pending'||key==='failed'||key==='unsupported'||key==='limited')group[key]++
      const bytes=Number.isSafeInteger(ref.size)&&ref.size>=0?ref.size:0
      group.sourceBytes+=bytes;group.indexedBytes+=excluded?0:indexed?.indexed_bytes??0
      if(ref.kind==='ai-raw'&&!excluded&&indexed?.status==='indexed'&&indexed.available_bytes>bytes){
        group.pending++;group.sourceBytes+=indexed.available_bytes-bytes
      }
      hashes.get(ref.kind)!.update(JSON.stringify([eventId,ref.file,ref.sha256,ref.size,key,indexed?.reason??'',indexed?.available_bytes??0]))
  }
  // Scan source metadata once. Only small pending-AI references need to wait
  // for confirmed snapshots; retaining entire event bodies would be unbounded.
  for (const tier of rows(snapshot, projectId)) for (const row of tier) {
    for (const ref of refsOf({ agentType: row.agent_type, data: JSON.parse(row.data) })) {
      if (ref.kind === 'ai-raw' && ref.pending) pending.push({ eventId: row.id, ref })
      else {
        if (ref.kind === 'ai-raw') confirmed.add(path.resolve(getProjectDir(), ref.file))
        record(row.id, ref)
      }
    }
  }
  for (const { eventId, ref } of pending) {
    if (!confirmed.has(path.resolve(getProjectDir(), ref.file))) record(eventId, ref)
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
