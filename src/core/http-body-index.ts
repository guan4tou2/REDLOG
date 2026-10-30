import { BODY_SOURCE_PREDICATE } from './content-contract'
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
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
  if (index.pragma('user_version', { simple: true }) !== 6)
    index.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state')
  index.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,event_id UNINDEXED,sha256 UNINDEXED,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE IF NOT EXISTS body_event_refs (
   event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
   status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,PRIMARY KEY(event_id,sha256)
  ); PRAGMA user_version=6;
  CREATE TEMP TABLE body_seen(event_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(event_id,sha256));`)
  indexDir = projectDir
  return index
}
export function closeHttpBodyIndex(): void { if (index) {
  try {
    index.close()
  }
  catch { }
} index = null; indexDir = null; }
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
  const db = getIndex(projectDir)
  db.transaction(() => {
    for (const ref of refsOf(event)) {
      let status = 'indexed', bytes = 0, reason = '',availableBytes=0
      const prior = db.prepare('SELECT status FROM body_event_refs WHERE event_id=? AND sha256=?').get(event.id, ref.sha256) as {
        status: string
      } | undefined
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
          db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
          const insert = db.prepare('INSERT INTO body_fts(content,event_id,sha256) VALUES(?,?,?)')
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
      if (status !== 'indexed')
        db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
      db.prepare(`INSERT INTO body_event_refs VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,sha256) DO UPDATE SET
    file=excluded.file,size=excluded.size,encoding=excluded.encoding,status=excluded.status,indexed_bytes=excluded.indexed_bytes,reason=excluded.reason,kind=excluded.kind,available_bytes=excluded.available_bytes`).run(event.id, ref.sha256, ref.file, Number.isSafeInteger(ref.size) ? ref.size : 0, String(ref.encoding ?? 'unknown'), status, bytes, reason, ref.kind,availableBytes)
    }
  })()
}
function rows(snapshot?: ExportSnapshot, projectId?: string) {
  const source = getDB()
  // A snapshot is a cumulative prefix of one saved file. Index the latest
  // confirmed version inside this dataset, rather than copying every prefix.
  const latest=(source.prepare(`WITH versions AS (
    SELECT id,engagement_id,created_at,rowid AS r,1 AS tier,json_extract(data,'$.snapshot_path') AS file FROM events
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    UNION ALL SELECT id,engagement_id,created_at,rowid,0,json_extract(data,'$.snapshot_path') FROM events_logged
      WHERE rowid<=? AND agent_type='agent' AND subtype='transcript_snapshot'
    ), ranked AS (SELECT id,row_number() OVER(PARTITION BY engagement_id,file ORDER BY created_at DESC,r DESC,tier DESC,id) AS n FROM versions)
    SELECT id FROM ranked WHERE n=1`).all(snapshot?.chainedMaxRowId??Number.MAX_SAFE_INTEGER,snapshot?.loggedMaxRowId??Number.MAX_SAFE_INTEGER) as {id:string}[]).map(row=>row.id)
  return (['events', 'events_logged'] as const).map((table, i) => {
    const max = snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
    return source.prepare(`SELECT id,data,agent_type FROM ${table} INDEXED BY idx_${table}_content_refs WHERE rowid<=? ${projectId ? 'AND engagement_id=?' : ''} AND (${BODY_SOURCE_PREDICATE})
      AND (agent_type<>'agent' OR coalesce(subtype,'')<>'transcript_snapshot' OR id IN (SELECT value FROM json_each(?))) ORDER BY rowid`).iterate(max, ...(projectId ? [projectId] : []),JSON.stringify(latest)) as IterableIterator<{
      id: string
      data: string
      agent_type:string
    }>
  })
}
function backfill(projectDir: string,snapshot?:ExportSnapshot): void {
  const db = getIndex(projectDir)
  db.transaction(() => {
    db.prepare('DELETE FROM body_seen').run()
    const seen = db.prepare('INSERT OR IGNORE INTO body_seen VALUES(?,?)')
    for (const tier of rows(snapshot))
      for (const row of tier) {
        const data = JSON.parse(row.data) as Record<string, unknown>
        linkHttpBodyEvent({ id: row.id, data, agentType:row.agent_type }, projectDir)
        for (const ref of refsOf({data,agentType:row.agent_type}))
          seen.run(row.id, ref.sha256)
      }
    db.prepare('DELETE FROM body_event_refs WHERE NOT EXISTS(SELECT 1 FROM body_seen s WHERE s.event_id=body_event_refs.event_id AND s.sha256=body_event_refs.sha256)').run()
    db.prepare("DELETE FROM body_fts WHERE NOT EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=body_fts.event_id AND r.sha256=body_fts.sha256 AND r.status='indexed')").run()
  })()
}
export function pruneHttpBodyIndex(sha256: string, projectDir = getProjectDir()): void {
  const db = getIndex(projectDir)
  db.transaction(() => { db.prepare('DELETE FROM body_fts WHERE sha256=?').run(sha256); db.prepare('DELETE FROM body_event_refs WHERE sha256=?').run(sha256); })()
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
  backfill(projectDir,snapshot)
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
