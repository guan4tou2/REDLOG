import Database from 'better-sqlite3'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDB, getProjectDir } from './db/index'
import type { RedLogEvent } from './db/events'
import type { ExportSnapshot } from './export-plan'
import { toFtsMatch } from './query/fts-match'
import { BODY_REF_FIELDS, type BodyRef } from './http-body-store'
import { withVerifiedBody, ContentAccessError } from './body-source'
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
  if (index.pragma('user_version', { simple: true }) !== 4)
    index.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state')
  index.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,event_id UNINDEXED,sha256 UNINDEXED,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE IF NOT EXISTS body_event_refs (
   event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
   status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(event_id,sha256)
  ); PRAGMA user_version=4;
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
function refsOf(data: Record<string, unknown>): BodyRef[] {
  return BODY_REF_FIELDS.flatMap(field => {
    const value = data[field]
    return value && typeof value === 'object' && typeof (value as BodyRef).sha256 === 'string' && typeof (value as BodyRef).file === 'string' ? [value as BodyRef] : []
  })
}
export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data'>, projectDir = getProjectDir()): void {
  const db = getIndex(projectDir)
  db.transaction(() => {
    for (const ref of refsOf(event.data)) {
      let status = 'indexed', bytes = 0, reason = ''
      const prior = db.prepare('SELECT status FROM body_event_refs WHERE event_id=? AND sha256=?').get(event.id, ref.sha256) as {
        status: string
      } | undefined
      try {
        withVerifiedBody(ref, source => {
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
        }, projectDir)
      }
      catch (error) {
        status = error instanceof ContentAccessError && error.status === 'missing' ? 'missing' : 'failed'
        reason = error instanceof ContentAccessError ? error.status : 'failed'
      }
      if (status !== 'indexed')
        db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
      db.prepare(`INSERT INTO body_event_refs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id,sha256) DO UPDATE SET
    file=excluded.file,size=excluded.size,encoding=excluded.encoding,status=excluded.status,indexed_bytes=excluded.indexed_bytes,reason=excluded.reason`).run(event.id, ref.sha256, ref.file, Number.isSafeInteger(ref.size) ? ref.size : 0, String(ref.encoding ?? 'unknown'), status, bytes, reason)
    }
  })()
}
function rows(snapshot?: ExportSnapshot, projectId?: string) {
  const source = getDB(), fields = BODY_REF_FIELDS.map(f => `json_extract(data,'$.${f}.sha256') IS NOT NULL`).join(' OR ')
  return (['events', 'events_logged'] as const).map((table, i) => {
    const max = snapshot ? (i === 0 ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId) : Number.MAX_SAFE_INTEGER
    return source.prepare(`SELECT id,data FROM ${table} WHERE rowid<=? ${projectId ? 'AND engagement_id=?' : ''} AND (${fields}) ORDER BY rowid`).iterate(max, ...(projectId ? [projectId] : [])) as IterableIterator<{
      id: string
      data: string
    }>
  })
}
function backfill(projectDir: string): void {
  const db = getIndex(projectDir)
  db.transaction(() => {
    db.prepare('DELETE FROM body_seen').run()
    const seen = db.prepare('INSERT OR IGNORE INTO body_seen VALUES(?,?)')
    for (const tier of rows())
      for (const row of tier) {
        const data = JSON.parse(row.data) as Record<string, unknown>
        linkHttpBodyEvent({ id: row.id, data }, projectDir)
        for (const ref of refsOf(data))
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
export function searchHttpBodyEventIds(query: string, projectDir = getProjectDir()): string[] {
  const match = toFtsMatch(query)
  if (!match)
    return []
  backfill(projectDir)
  const db = getIndex(projectDir)
  // Failed references have already lost their FTS rows. Report them through
  // coverage without withholding unrelated, verified matches.
  // AND remains scoped to one saved body even when its terms occur in
  // different chunks. A term must never be assembled across unrelated refs.
  const terms = query.trim().split(/\s+/).filter(Boolean)
  let matches: Map<string, string> | undefined
  for (const [i, term] of terms.entries()) {
    const quoted = `"${term.replace(/"/g, '""')}"${i === terms.length - 1 ? '*' : ''}`
    const rows = db.prepare('SELECT DISTINCT event_id,sha256 FROM body_fts WHERE body_fts MATCH ?').all(quoted) as {event_id:string;sha256:string}[]
    const current = new Map(rows.map(row => [JSON.stringify([row.event_id,row.sha256]),row.event_id]))
    matches = matches ? new Map([...matches].filter(([key])=>current.has(key))) : current
    if (!matches.size) break
  }
  return [...new Set(matches?.values() ?? [])]
}
export interface BodySearchCoverage {
  revision: string
  indexed: number
  missing: number
  binary: number
  limited: number
  pending: number
  failed: number
  indexedBytes: number
  sourceBytes: number
}
/** A source-scoped manifest, not a claim that every attachment was indexed. */
export function bodySearchCoverage(snapshot?: ExportSnapshot, projectId?: string): BodySearchCoverage {
  const hash = createHash('sha256'), coverage: BodySearchCoverage = { revision: '', indexed: 0, missing: 0, binary: 0, limited: 0, pending: 0, failed: 0, indexedBytes: 0, sourceBytes: 0 }
  let lookup: Database.Statement | undefined
  hash.update('body-index-v4:chunked-utf8')
  for (const tier of rows(snapshot, projectId))
    for (const row of tier)
      for (const ref of refsOf(JSON.parse(row.data) as Record<string, unknown>)) {
        lookup ??= getIndex().prepare('SELECT status,indexed_bytes,reason FROM body_event_refs WHERE event_id=? AND sha256=?')
        const status = lookup.get(row.id, ref.sha256) as {
          status: string
          indexed_bytes: number
          reason: string
        } | undefined
        const key = status?.status ?? 'pending'
        if (key === 'indexed' || key === 'missing' || key === 'binary' || key === 'limited' || key === 'pending' || key === 'failed')
          coverage[key]++
        coverage.sourceBytes += Number.isSafeInteger(ref.size) ? ref.size : 0
        coverage.indexedBytes += status?.indexed_bytes ?? 0
        hash.update(JSON.stringify([row.id, ref.sha256, ref.size, ref.encoding, key, status?.indexed_bytes ?? 0, status?.reason ?? '']))
      }
  coverage.revision = hash.digest('hex')
  return coverage
}
