import Database from 'better-sqlite3'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDB, getProjectDir } from './db/index'
import type { RedLogEvent } from './db/events'
import type { ExportSnapshot } from './export-plan'
import { toFtsMatch } from './query/fts-match'
import { BODY_REF_FIELDS, type BodyRef } from './http-body-store'
import { withVerifiedBody, ContentAccessError } from './body-source'
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
let index: Database.Database | null = null, indexDir: string | null = null
function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir)
    return index
  closeHttpBodyIndex()
  index = new Database(path.join(projectDir, 'http-body-index.db'))
  index.pragma('journal_mode = WAL')
  // Rebuild only this disposable index, never a source Event or sidecar.
  if (index.pragma('user_version', { simple: true }) !== 3)
    index.exec('DROP TABLE IF EXISTS body_fts; DROP TABLE IF EXISTS body_event_refs; DROP TABLE IF EXISTS body_index_state')
  index.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content,event_id UNINDEXED,sha256 UNINDEXED,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE IF NOT EXISTS body_event_refs (
   event_id TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
   status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(event_id,sha256)
  ); PRAGMA user_version=3;
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
        if (ref.size > MAX_DOCUMENT_BYTES) {
          status = 'limited'
          reason = 'size-limit'
        }
        else
          withVerifiedBody(ref, source => {
            if (source.format === 'binary') {
              status = 'binary'
              reason = 'binary'
              return
            }
            bytes = source.bytes
            if (prior?.status === 'indexed')
              return
            const parts: Buffer[] = []
            for (let off = 0; off < source.bytes; off += 65536)
              parts.push(source.read(off, Math.min(65536, source.bytes - off)))
            db.prepare('DELETE FROM body_fts WHERE event_id=? AND sha256=?').run(event.id, ref.sha256)
            db.prepare('INSERT INTO body_fts(content,event_id,sha256) VALUES(?,?,?)').run(Buffer.concat(parts).toString('utf8'), event.id, ref.sha256)
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
  return (db.prepare('SELECT DISTINCT event_id FROM body_fts WHERE body_fts MATCH ?').all(match) as {
    event_id: string
  }[]).map(r => r.event_id)
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
  hash.update('body-index-v3:decoded-utf8')
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
