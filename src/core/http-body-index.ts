import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDB, getProjectDir } from './db/index'
import type { RedLogEvent } from './db/events'

const REF_FIELDS = ['request_body_ref', 'response_body_ref', 'ws_body_ref', 'tcp_body_ref'] as const
let index: Database.Database | null = null
let indexDir: string | null = null

function matchQuery(raw: string): string | null {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((term, i) => {
    const quoted = `"${term.replace(/"/g, '""')}"`
    return i === terms.length - 1 ? `${quoted}*` : quoted
  }).join(' ')
}

function getIndex(projectDir = getProjectDir()): Database.Database {
  if (index && indexDir === projectDir) return index
  closeHttpBodyIndex()
  index = new Database(path.join(projectDir, 'http-body-index.db'))
  index.pragma('journal_mode = WAL')
  index.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(
      content, event_id UNINDEXED, sha256 UNINDEXED,
      tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
    CREATE TABLE IF NOT EXISTS body_event_refs (
      event_id TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY (event_id, sha256)
    );
    CREATE TABLE IF NOT EXISTS body_index_state (
      tier TEXT PRIMARY KEY, max_rowid INTEGER NOT NULL
    );
  `)
  indexDir = projectDir
  return index
}

export function closeHttpBodyIndex(): void {
  if (index) { try { index.close() } catch { /* already closed */ } }
  index = null
  indexDir = null
}

function refsOf(event: Pick<RedLogEvent, 'id' | 'data'>): Array<{ sha256: string; file: string; encoding: string }> {
  const refs: Array<{ sha256: string; file: string; encoding: string }> = []
  for (const field of REF_FIELDS) {
    const value = event.data[field]
    if (!value || typeof value !== 'object') continue
    const ref = value as { sha256?: unknown; file?: unknown; encoding?: unknown }
    if (typeof ref.sha256 === 'string' && typeof ref.file === 'string') {
      refs.push({ sha256: ref.sha256, file: ref.file, encoding: String(ref.encoding ?? 'text') })
    }
  }
  return refs
}

export function linkHttpBodyEvent(event: Pick<RedLogEvent, 'id' | 'data'>, projectDir = getProjectDir()): void {
  const db = getIndex(projectDir)
  const bodiesDir = path.join(projectDir, 'http-bodies')
  const known = db.prepare('SELECT 1 FROM body_event_refs WHERE event_id = ? AND sha256 = ?')
  const insertRef = db.prepare('INSERT OR IGNORE INTO body_event_refs (event_id, sha256) VALUES (?, ?)')
  const insertText = db.prepare('INSERT INTO body_fts (content, event_id, sha256) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const ref of refsOf(event)) {
      if (ref.encoding !== 'text' || known.get(event.id, ref.sha256)) continue
      const filePath = path.join(bodiesDir, path.basename(ref.file))
      if (!fs.existsSync(filePath)) continue
      // An existing but unreadable sidecar is a query failure, not an empty
      // document. Throw so backfill does not advance past evidence it failed
      // to index; Search already exposes this as a retryable error.
      const content = fs.readFileSync(filePath, 'utf8')
      insertText.run(content, event.id, ref.sha256)
      insertRef.run(event.id, ref.sha256)
    }
  })()
}

function backfill(projectDir: string): void {
  const source = getDB()
  const target = getIndex(projectDir)
  for (const [tier, table] of [['chained', 'events'], ['logged', 'events_logged']] as const) {
    const state = target.prepare('SELECT max_rowid FROM body_index_state WHERE tier = ?').get(tier) as { max_rowid: number } | undefined
    const after = state?.max_rowid ?? 0
    const rows = source.prepare(`
      SELECT rowid, id, data FROM ${table}
      WHERE rowid > ? AND (
        json_extract(data, '$.request_body_ref.sha256') IS NOT NULL OR
        json_extract(data, '$.response_body_ref.sha256') IS NOT NULL OR
        json_extract(data, '$.ws_body_ref.sha256') IS NOT NULL OR
        json_extract(data, '$.tcp_body_ref.sha256') IS NOT NULL
      ) ORDER BY rowid
    `).all(after) as Array<{ rowid: number; id: string; data: string }>
    for (const row of rows) {
      let data: Record<string, unknown>
      try { data = JSON.parse(row.data) as Record<string, unknown> } catch { continue }
      linkHttpBodyEvent({ id: row.id, data }, projectDir)
    }
    const newest = source.prepare(`SELECT MAX(rowid) AS rowid FROM ${table}`).get() as { rowid: number | null }
    target.prepare(`
      INSERT INTO body_index_state (tier, max_rowid) VALUES (?, ?)
      ON CONFLICT(tier) DO UPDATE SET max_rowid = excluded.max_rowid
    `).run(tier, newest.rowid ?? after)
  }
}

export function pruneHttpBodyIndex(sha256: string, projectDir = getProjectDir()): void {
  const db = getIndex(projectDir)
  db.transaction(() => {
    db.prepare('DELETE FROM body_fts WHERE sha256 = ?').run(sha256)
    db.prepare('DELETE FROM body_event_refs WHERE sha256 = ?').run(sha256)
  })()
}

export function searchHttpBodyEventIds(query: string, projectDir = getProjectDir()): string[] {
  const match = matchQuery(query)
  if (!match) return []
  backfill(projectDir)
  return (getIndex(projectDir).prepare('SELECT DISTINCT event_id FROM body_fts WHERE body_fts MATCH ?').all(match) as Array<{ event_id: string }>)
    .map((row) => row.event_id)
}
