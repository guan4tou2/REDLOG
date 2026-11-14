// How the body index stores and addresses its documents (decision 2026-11-14
// §6). Each ref has an id of its own that is never reused; document n of kind
// k of ref r is rowid r*refSpan + k*kindSpan + n, written with INSERT OR
// REPLACE, removed by rowid from the counts the ref row records.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { savedBody, savedResponse } from './helpers/body-index-work'
import { searchHttpBodyEventIds } from './helpers/body-search'
import { documentRowids, documentHolds } from './helpers/body-index-layout'

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
const readIndex = <T>(run: (index: Database.Database) => T): T => {
  const index = new Database(indexFile(), { readonly: true })
  try { return run(index) } finally { index.close() }
}
/** A document no ref accounts for, written straight into the shared index: what
 *  a fault, or a future write path, could leave at a rowid. */
const plant = (rowid: number, text: string): void => {
  const index = new Database(indexFile())
  try { index.prepare('INSERT INTO body_fts(rowid,content) VALUES(?,?)').run(rowid, text) } finally { index.close() }
}
const refRow = (id: string) => readIndex(index => index.prepare('SELECT ref,status,reason,raw_docs,decoded_docs FROM body_event_refs WHERE event_id=?').get(id) as
  { ref: number; status: string; reason: string; raw_docs: number; decoded_docs: number })
function refs(): Array<{ ref: number; event_id: string; sha256: string }> {
  const index = new Database(indexFile(), { readonly: true })
  try { return index.prepare('SELECT ref,event_id,sha256 FROM body_event_refs ORDER BY ref').all() as Array<{ ref: number; event_id: string; sha256: string }> } finally { index.close() }
}

sqlite.describe('body index layout', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-layout-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx._limitDocumentsPerKind(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

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
      expect(index.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'body_docs%'").all()).toEqual([])
      // Contentless: the words are indexed, the text is not kept.
      expect((index.prepare("SELECT sql FROM sqlite_master WHERE name='body_fts'").get() as { sql: string }).sql).toContain("content='',contentless_delete=1")
      expect(index.prepare('SELECT rowid,content FROM body_fts').all()).toEqual([{ rowid: idx._documentRowid(1, 0, 0), content: null }])
    } finally { index.close() }
  })

  it('a document left at the rowids of a dead ref is not inherited by the ref that comes next', () => {
    savedResponse('A', { response_body_ref: savedBody(dir, '{"v":"ABODYWORD"}') })
    expect(searchHttpBodyEventIds('ABODYWORD', dir)).toEqual(['A'])
    const before = refRow('A')
    idx.pruneHttpBodyIndex(refs()[0].sha256, dir)
    plant(idx._documentRowid(before.ref, 0, 0), 'LEFTOVERWORD')
    // The next search walks (a prune forgets the watermark) and links A anew.
    expect(searchHttpBodyEventIds('ABODYWORD', dir)).toEqual(['A'])
    expect(refRow('A').ref).toBeGreaterThan(before.ref)
    expect(searchHttpBodyEventIds('LEFTOVERWORD', dir)).toEqual([])
  })

  it('a match counts only inside the documents its ref records, also once the ref has lost its text', () => {
    const text = '{"v":"COUNTEDWORD"}', ref = savedBody(dir, text), file = path.join(dir, 'http-bodies', ref.file)
    savedResponse('E', { response_body_ref: ref })
    expect(searchHttpBodyEventIds('COUNTEDWORD', dir)).toEqual(['E'])
    const indexed = refRow('E')
    expect(indexed).toMatchObject({ status: 'indexed', raw_docs: 1, decoded_docs: 0 })
    // Inside E's range, outside its counts: the second saved document and the
    // first decoded one, which E does not have.
    plant(idx._documentRowid(indexed.ref, 0, 1), 'UNCOUNTEDWORD')
    plant(idx._documentRowid(indexed.ref, 1, 0), 'UNCOUNTEDDECODED')
    expect(searchHttpBodyEventIds('UNCOUNTEDWORD', dir)).toEqual([])
    expect(searchHttpBodyEventIds('UNCOUNTEDDECODED', dir)).toEqual([])
    // The body changes: E is failed and counts nothing. Its counted document
    // goes; search and coverage agree that nothing of E is found.
    fs.writeFileSync(file, text.replace('COUNTEDWORD', 'CHANGEDWORDX'))
    expect(searchHttpBodyEventIds('COUNTEDWORD', dir)).toEqual([])
    expect(refRow('E')).toMatchObject({ status: 'failed', raw_docs: 0 })
    expect(searchHttpBodyEventIds('UNCOUNTEDWORD', dir)).toEqual([])
    expect(idx.bodySearchCoverage().sources!.find(s => s.kind === 'body')).toMatchObject({ status: 'failed', failed: 1, indexed: 0 })
  })

  it('every document write replaces what its rowid held', () => {
    const ref = savedBody(dir, '{"v":"REALWORD"}'), file = path.join(dir, 'http-bodies', ref.file)
    fs.rmSync(file)
    savedResponse('E', { response_body_ref: ref })
    expect(searchHttpBodyEventIds('REALWORD', dir)).toEqual([])
    const missing = refRow('E')
    expect(missing).toMatchObject({ status: 'missing', raw_docs: 0 })
    // Something left at the rowid E's first document will take.
    const first = idx._documentRowid(missing.ref, 0, 0)
    plant(first, 'STALEWORD')
    fs.writeFileSync(file, '{"v":"REALWORD"}')
    expect(searchHttpBodyEventIds('REALWORD', dir)).toEqual(['E'])
    // A plain INSERT there is refused by a table that stores its text, and
    // added to by a contentless one: the old words would stay searchable.
    expect(searchHttpBodyEventIds('STALEWORD', dir)).toEqual([])
    readIndex(index => expect({ real: documentHolds(index, first, 'REALWORD'), stale: documentHolds(index, first, 'STALEWORD') }).toEqual({ real: true, stale: false }))
  })

  it('a read that ends without text removes the documents the ref had, of both kinds', () => {
    // Saved and decoded: one document of each kind.
    const text = `{"v":"OLDWORD \\u65b0\\u8a5e"}`, ref = savedBody(dir, text), file = path.join(dir, 'http-bodies', ref.file)
    savedResponse('E', { response_body_ref: ref })
    expect(searchHttpBodyEventIds('新詞', dir)).toEqual(['E'])
    const indexed = refRow('E')
    expect(indexed).toMatchObject({ status: 'indexed', raw_docs: 1, decoded_docs: 1 })
    readIndex(index => expect(documentRowids(index, 'E')).toEqual([idx._documentRowid(indexed.ref, 0, 0), idx._documentRowid(indexed.ref, 1, 0)]))
    // The same size, other bytes: its hash no longer matches, and the next
    // search re-reads it after its signature changed.
    fs.writeFileSync(file, text.replace('OLDWORD', 'NEWWORD'))
    expect(searchHttpBodyEventIds('OLDWORD', dir)).toEqual([])
    expect(searchHttpBodyEventIds('新詞', dir)).toEqual([])
    expect(refRow('E')).toMatchObject({ status: 'failed', raw_docs: 0, decoded_docs: 0 })
    readIndex(index => expect(documentRowids(index, 'E')).toEqual([]))
  })

  it('a body that would need more documents than its rowids hold is indexed as far as they go, and is partial', () => {
    idx._limitDocumentsPerKind(1)
    const filler = 'filler words '.repeat(100_000)
    const ref = savedBody(dir, `{"v":"HEADWORD ${filler} TAILWORD"}`)
    savedResponse('E', { response_body_ref: ref })
    expect(searchHttpBodyEventIds('HEADWORD', dir)).toEqual(['E'])
    expect(searchHttpBodyEventIds('TAILWORD', dir)).toEqual([])
    expect(refRow('E')).toMatchObject({ status: 'partial', reason: 'too-large', raw_docs: 1, decoded_docs: 0 })
    expect(idx.bodySearchCoverage().sources!.find(s => s.kind === 'body')).toMatchObject({ status: 'partial', partial: 1 })
  })

  it('two refs never share a rowid: each has its own range, and a document beyond it is refused', () => {
    const { refSpan, kindSpan, maxRef } = idx._documentLayout()
    // KIND_SPAN covers a body at the default capture cap (10 MiB) many times
    // over: at most ceil(10 MiB / 1 MiB) + 2 documents of each kind.
    expect(kindSpan).toBeGreaterThanOrEqual(Math.ceil(10 * 1024 * 1024 / (1024 * 1024)) + 2)
    expect(refSpan).toBe(2 * kindSpan)
    // Generated counts and refs, the extremes included.
    const counts = [0, 1, 2, 12, kindSpan - 1, ...Array.from({ length: 40 }, (_, i) => (i * 7919) % kindSpan)]
    const ids = [1, 2, 3, 4097, 2 ** 32, maxRef - 2, maxRef - 1, ...Array.from({ length: 20 }, (_, i) => 1 + ((i * 2654435761) % (maxRef - 1)))]
    for (const ref of ids) for (const kind of [0, 1] as const) for (const n of counts) {
      const rowid = idx._documentRowid(ref, kind, n)
      expect(Number.isSafeInteger(rowid)).toBe(true)
      // The ref, kind and number come back out, so no two (ref, kind, n) share it.
      expect([Math.floor(rowid / refSpan), Math.floor((rowid % refSpan) / kindSpan), rowid % kindSpan]).toEqual([ref, kind, n])
    }
    expect(idx._documentRowid(maxRef - 1, 1, kindSpan - 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => idx._documentRowid(1, 0, kindSpan)).toThrow(RangeError)
    expect(() => idx._documentRowid(1, 1, kindSpan)).toThrow(RangeError)
    expect(() => idx._documentRowid(maxRef, 0, 0)).toThrow(RangeError)
    expect(() => idx._documentRowid(0, 0, 0)).toThrow(RangeError)
  })

  it('the last ref id the table takes has exact rowids, and the next is refused', () => {
    const { maxRef } = idx._documentLayout()
    savedResponse('A', { response_body_ref: savedBody(dir, '{"v":"FIRSTWORD"}') })
    expect(searchHttpBodyEventIds('FIRSTWORD', dir)).toEqual(['A'])
    const index = new Database(indexFile())
    try { index.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='body_event_refs'").run(maxRef - 2) } finally { index.close() }
    savedResponse('B', { response_body_ref: savedBody(dir, '{"v":"LASTWORD"}') })
    expect(searchHttpBodyEventIds('LASTWORD', dir)).toEqual(['B'])
    expect(refRow('B').ref).toBe(maxRef - 1)
    readIndex(index => expect(documentRowids(index, 'B')).toEqual([idx._documentRowid(maxRef - 1, 0, 0)]))
    savedResponse('C', { response_body_ref: savedBody(dir, '{"v":"OVERWORD"}') })
    expect(() => searchHttpBodyEventIds('OVERWORD', dir)).toThrow(/CHECK constraint failed/)
  })

  it('a rowid bound beside MATCH is compared as an integer only when cast', () => {
    savedResponse('A', { response_body_ref: savedBody(dir, '{"v":"alphaword"}') })
    savedResponse('B', { response_body_ref: savedBody(dir, '{"v":"betaword"}') })
    expect(searchHttpBodyEventIds('alphaword', dir)).toEqual(['A'])
    const ofB = idx._documentRowid(refRow('B').ref, 0, 0)
    readIndex(index => {
      // better-sqlite3 binds a JS number as REAL, and FTS5 then ignores the
      // rowid and returns every match: B's rowid "holds" A's word.
      expect(index.prepare("SELECT count(*) AS n FROM body_fts WHERE body_fts MATCH 'alphaword' AND rowid=?").get(ofB)).toEqual({ n: 1 })
      expect({ a: documentHolds(index, ofB, 'alphaword'), b: documentHolds(index, ofB, 'betaword') }).toEqual({ a: false, b: true })
    })
  })

  it('a TEMP document is joined to TEMP refs and a shared one to shared refs, though their ids are the same numbers', () => {
    savedResponse('A', { response_body_ref: savedBody(dir, '{"v":"SHAREDWORD"}') })
    expect(searchHttpBodyEventIds('SHAREDWORD', dir)).toEqual(['A'])
    expect(refRow('A').ref).toBe(1)
    // B arrives while another connection holds the index: this connection
    // reads it into its own TEMP tables, where the first ref id is 1 too.
    savedResponse('B', { response_body_ref: savedBody(dir, '{"v":"TEMPWORD"}') })
    const holder = new Database(indexFile())
    holder.prepare('BEGIN IMMEDIATE').run()
    let found
    try { found = idx.searchHttpBodyTermIds('SHAREDWORD TEMPWORD', dir) } finally { holder.prepare('ROLLBACK').run(); holder.close() }
    expect(idx._extraEvents(dir)).toBe(1)
    expect(found).toEqual([{ term: '"SHAREDWORD"', eventIds: ['A'] }, { term: '"TEMPWORD"*', eventIds: ['B'] }])
  }, 30_000)
})
