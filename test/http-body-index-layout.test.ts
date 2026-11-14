// How the body index stores and addresses its documents (decision 2026-11-14
// §6). Each ref has an id of its own that is never reused.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { savedBody, savedResponse } from './helpers/body-index-work'
import { searchHttpBodyEventIds } from './helpers/body-search'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  db = await import('../src/core/db')
  idx = await import('../src/core/http-body-index')
}
let dir = ''
const indexFile = (): string => path.join(dir, 'http-body-index.db')
/** A base64 body on the event itself: linked at ingest, no file needed. */
const inline = (text: string) => {
  const b = Buffer.from(text)
  return { data: b.toString('base64'), encoding: 'base64', size: b.length, sha256: createHash('sha256').update(b).digest('hex') }
}
/** The schema v10 wrote (the commit before v11), verbatim. */
const V10 = `CREATE VIRTUAL TABLE body_fts USING fts5(content,tokenize='unicode61 remove_diacritics 2',prefix='2 3');
  CREATE TABLE body_docs (doc INTEGER PRIMARY KEY,event_id TEXT NOT NULL,slot TEXT NOT NULL,sha256 TEXT NOT NULL);
  CREATE INDEX body_docs_ref ON body_docs(event_id,slot);
  CREATE INDEX body_docs_sha256 ON body_docs(sha256);
  CREATE TABLE body_event_refs (event_id TEXT NOT NULL,slot TEXT NOT NULL,sha256 TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,encoding TEXT NOT NULL,
     status TEXT NOT NULL,indexed_bytes INTEGER NOT NULL,reason TEXT NOT NULL,kind TEXT NOT NULL,available_bytes INTEGER NOT NULL,
     tier TEXT,verified_desc TEXT,verified_file TEXT,verified_sig TEXT,
     engagement_id TEXT,row INTEGER,pos INTEGER NOT NULL,source_bytes INTEGER NOT NULL,PRIMARY KEY(event_id,slot));
  CREATE INDEX body_event_refs_sha256 ON body_event_refs(sha256);
  CREATE INDEX body_event_refs_order ON body_event_refs(tier,row,pos);
  CREATE TABLE body_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`
const link = (id: string, text: string): void => idx.linkHttpBodyEvent({ id, data: { subtype: 'http_response', response_body: inline(text) } }, dir)
function refs(): Array<{ ref: number; event_id: string; sha256: string }> {
  const index = new Database(indexFile(), { readonly: true })
  try { return index.prepare('SELECT ref,event_id,sha256 FROM body_event_refs ORDER BY ref').all() as Array<{ ref: number; event_id: string; sha256: string }> } finally { index.close() }
}

sqlite.describe('body index layout', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-layout-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('a ref id is never reused once its row is deleted', () => {
    link('A', 'first body')
    const [a] = refs()
    idx.pruneHttpBodyIndex(a.sha256, dir)
    expect(refs()).toEqual([])
    link('B', 'second body')
    const [b] = refs()
    expect(b.event_id).toBe('B')
    expect(b.ref).toBeGreaterThan(a.ref)
  })

  it('a v10 index is dropped and rebuilt from the saved bodies, watermark and all', () => {
    const ref = savedBody(dir, '{"v":"CURRENTWORD"}')
    savedResponse('E', { response_body_ref: ref })
    // An index as v10 left it, holding a document no saved body has, and a
    // watermark that vouches for every row.
    const old = new Database(indexFile())
    old.exec(V10)
    old.prepare("INSERT INTO body_fts(rowid,content) VALUES(1,'STALEWORD')").run()
    old.prepare("INSERT INTO body_docs VALUES(1,'E','response_body_ref',?)").run(ref.sha256)
    old.prepare(`INSERT INTO body_event_refs VALUES('E','response_body_ref',?,?,?,'text','indexed',?,'','body',?,'events_logged',NULL,NULL,NULL,'project',1,0,?)`)
      .run(ref.sha256, ref.file, ref.size, ref.size, ref.size, ref.size)
    old.prepare("INSERT INTO body_index_meta VALUES('mark',?)").run(JSON.stringify({ latest: [], tiers: [{ n: 0, max: 0, idAtMax: null }, { n: 1, max: 1, idAtMax: 'E' }] }))
    old.pragma('user_version=10')
    old.close()
    expect(searchHttpBodyEventIds('STALEWORD', dir)).toEqual([])
    expect(searchHttpBodyEventIds('CURRENTWORD', dir)).toEqual(['E'])
    const index = new Database(indexFile(), { readonly: true })
    try {
      expect(index.pragma('user_version', { simple: true })).toBe(11)
      expect(index.prepare('SELECT ref,event_id FROM body_event_refs').all()).toEqual([{ ref: 1, event_id: 'E' }])
    } finally { index.close() }
  })
})
