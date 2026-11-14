// When SQLite itself rolls the index's transaction back mid-sync (a full
// disk: SQLITE_FULL; also SQLITE_IOERR and others), nothing may be written
// after it, the watermark least of all: statements after an automatic
// rollback run in autocommit, one by one, and a watermark written that way
// vouches for rows that were rolled back. The search then answers from what
// the index still truthfully describes plus this connection's TEMP tables,
// and the next search repairs the index.
//
// The fault is injected by a test-only wrapper around prepare, on the index's
// own connection: either a real SQLITE_FULL (max_page_count set to the
// database's current size, so the next write that needs a page fails with a
// genuine automatic rollback) or a simulated one (ROLLBACK, then the error
// SQLite reports). A statement error that does not roll back (a constraint)
// fails one ref and the sync goes on.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parsed, savedBody, savedResponse, bodySource } from './helpers/body-index-work'
import { layoutViolations } from './helpers/body-index-layout'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
}
let dir = ''
const indexFile = (): string => path.join(dir, 'http-body-index.db')
const search = (text = 'commonword') => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 100 })
/** Rows whose saved body holds `commonword` and `item<i>`, in one commit. */
const add = (from: number, to: number, pad = 0): void => db.getDB().transaction(() => {
  for (let i = from; i < to; i++) savedResponse(`e${i}`, { response_body_ref: savedBody(dir, `{"v":"commonword item${i} ${'pad '.repeat(pad)}"}`) })
})()
const ids = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `e${from + i}`).sort()
/** Everything the shared index holds, read through a connection of its own. */
function shared(): { refs: unknown[]; documents: number[]; meta: unknown[]; layout: ReturnType<typeof layoutViolations> } {
  const index = new Database(indexFile(), { readonly: true })
  try {
    return {
      refs: index.prepare('SELECT ref,event_id,status,raw_docs,decoded_docs FROM body_event_refs ORDER BY ref').all(),
      documents: (index.prepare('SELECT rowid AS id FROM body_fts ORDER BY rowid').all() as { id: number }[]).map(r => r.id),
      meta: index.prepare('SELECT key,value FROM body_index_meta ORDER BY key').all(),
      layout: layoutViolations(index),
    }
  } finally { index.close() }
}
const CLEAN = { stray: 0, missing: 0, textless: 0 }

type How = 'simulated' | 'real' | 'constraint'
/** At the `at`-th execution (and every one after it, with `every`) of an
 *  index statement matching `sql` and, if given, whose arguments `when`
 *  accepts, fail as `how` says. Real: from then on the database may not grow
 *  by a page, until lift(); the first write that needs one fails, wherever
 *  that is (FTS5 holds new documents in memory until it flushes, at commit
 *  for a small sync). Statements are cached per index handle, so the handle
 *  is closed first: the next call prepares them again through this wrapper. */
function fault(sql: RegExp, at: number, how: How, every = false, when: (args: unknown[]) => boolean = () => true): { hits: () => number } {
  idx.closeHttpBodyIndex()
  let seen = 0, hits = 0
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
    const s = prepare.call(this, text)
    if (!this.name.endsWith('http-body-index.db') || !sql.test(text)) return s
    const conn = this, run = s.run.bind(s)
    ;(s as unknown as { run: (...a: unknown[]) => unknown }).run = (...a: unknown[]) => {
      if (!when(a)) return run(...a)
      seen++
      if (seen === at || (every && seen > at)) {
        hits++
        if (how === 'constraint') throw new Database.SqliteError('CHECK constraint failed: injected', 'SQLITE_CONSTRAINT_CHECK')
        if (how === 'simulated') {
          if (conn.inTransaction) conn.exec('ROLLBACK')
          throw new Database.SqliteError('database or disk is full', 'SQLITE_FULL')
        }
        conn.pragma(`main.max_page_count=${conn.pragma('main.page_count', { simple: true })}`)
        return run(...a)
      }
      return run(...a)
    }
    return s
  })
  return { hits: () => hits }
}
const lift = (): void => { vi.restoreAllMocks(); idx.closeHttpBodyIndex() }

const DOCUMENT = /^INSERT OR REPLACE INTO body_fts\(/
const PLACEHOLDER = /^INSERT INTO body_event_refs\(event_id,slot,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,pos,source_bytes\)/
const COUNTS = /^UPDATE body_event_refs SET sha256=/
const MARK = /^INSERT INTO body_index_meta VALUES\('mark'/
const TEMP_DOCUMENT = /^INSERT OR REPLACE INTO body_x_fts\(/

sqlite.describe('an automatic rollback of the body index', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-rollback-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  // In an incremental sync (5 rows indexed, 5 new), at a write of each kind.
  it.each([
    ['the first document', DOCUMENT, 1],
    ['a later document', DOCUMENT, 3],
    ['a placeholder ref row', PLACEHOLDER, 2],
    ['the ref-count update', COUNTS, 2],
    ['the watermark', MARK, 1],
  ] as const)('incremental, simulated at %s: the search answers, the index is as before, the next search repairs it', (_, sql, at) => {
    add(0, 5)
    expect(search().items.map(e => e.id).sort()).toEqual(ids(0, 5))
    const before = shared()
    add(5, 10)
    const injected = fault(sql, at, 'simulated')
    const during = search()
    expect(injected.hits()).toBe(1)
    // The rows the index does not describe were read into TEMP instead.
    expect({ items: during.items.map(e => e.id).sort(), coverage: bodySource(during)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
    // Nothing of the rolled-back sync is left, and nothing vouches for it.
    expect(shared()).toEqual(before)
    lift()
    const after = search()
    expect({ items: after.items.map(e => e.id).sort(), coverage: bodySource(after)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
    expect(shared()).toMatchObject({ layout: CLEAN, refs: expect.arrayContaining([expect.objectContaining({ event_id: 'e9', status: 'indexed', raw_docs: 1 })]) })
    expect(shared().refs).toHaveLength(10)
  })

  it('incremental, and TEMP full too: the search answers what the index vouches for and says the rest is not covered', () => {
    add(0, 5)
    search()
    const before = shared()
    add(5, 10)
    fault(/^INSERT OR REPLACE INTO body_(x_)?fts\(/, 1, 'simulated', true)
    const during = search()
    expect(during.items.map(e => e.id).sort()).toEqual(ids(0, 5))
    expect(bodySource(during)).toMatchObject({ status: 'partial', indexed: 5, pending: 5 })
    expect(shared()).toEqual(before)
    lift()
    const after = search()
    expect({ items: after.items.map(e => e.id).sort(), coverage: bodySource(after)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
    expect(shared().layout).toEqual(CLEAN)
  })

  // A connection that cannot sync reads the rows the watermark does not cover
  // into TEMP, as a read-only reader always does; TEMP has a file of its own,
  // which can fill while the index does not. Here the lock is held.
  it('TEMP full while another connection holds the index: the vouched rows are found, the rest is not covered', () => {
    add(0, 5)
    search()
    const before = shared()
    add(5, 10)
    fault(TEMP_DOCUMENT, 1, 'simulated', true)
    const holder = new Database(indexFile())
    holder.prepare('BEGIN IMMEDIATE').run()
    let during
    try { during = search() } finally { holder.prepare('ROLLBACK').run(); holder.close() }
    expect(during.items.map(e => e.id).sort()).toEqual(ids(0, 5))
    expect(bodySource(during)).toMatchObject({ status: 'partial', indexed: 5, pending: 5 })
    expect(shared()).toEqual(before)
    lift()
    const after = search()
    expect({ items: after.items.map(e => e.id).sort(), coverage: bodySource(after)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
  }, 30_000)

  it('the first sync of a fresh index, simulated at a later document: nothing is kept, not even the directories row', () => {
    add(0, 5)
    fault(DOCUMENT, 3, 'simulated')
    const during = search()
    expect({ items: during.items.map(e => e.id).sort(), coverage: bodySource(during)?.status }).toEqual({ items: ids(0, 5), coverage: 'covered' })
    expect(shared()).toEqual({ refs: [], documents: [], meta: [], layout: CLEAN })
    lift()
    expect(search().items.map(e => e.id).sort()).toEqual(ids(0, 5))
    expect(shared()).toMatchObject({ layout: CLEAN, meta: [expect.objectContaining({ key: 'directories' }), expect.objectContaining({ key: 'mark' })] })
  })

  // Real: from the second document on, or from the watermark write (the
  // last statement before COMMIT, where FTS5 flushes what it holds), the
  // database may not grow; bodies of about 40 KB need pages it does not have.
  it.each([['the second document', DOCUMENT, 2], ['the watermark write', MARK, 1]] as const)('a real SQLITE_FULL from %s on behaves as the simulated one', (_, sql, at) => {
    add(0, 5)
    search()
    const before = shared()
    add(5, 10, 10_000)
    const injected = fault(sql, at, 'real')
    const during = search()
    expect(injected.hits()).toBe(1)
    expect({ items: during.items.map(e => e.id).sort(), coverage: bodySource(during)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
    expect(shared()).toEqual(before)
    lift()
    const after = search()
    expect({ items: after.items.map(e => e.id).sort(), coverage: bodySource(after)?.status }).toEqual({ items: ids(0, 10), coverage: 'covered' })
    expect(shared().layout).toEqual(CLEAN)
    expect(shared().refs).toHaveLength(10)
  })

  it('a statement error that does not roll back fails that one ref, and the rest of the sync stands', () => {
    add(0, 5)
    search()
    add(5, 10)
    // Every write of e7's text, so recheck's retry in the same sync fails too.
    fault(DOCUMENT, 1, 'constraint', true, a => String(a[1]).includes('item7 '))
    const during = search()
    const failed = (shared().refs as Array<{ event_id: string; status: string }>).filter(r => r.status !== 'indexed').map(r => r.event_id)
    expect(failed).toEqual(['e7'])
    expect(during.items.map(e => e.id).sort()).toEqual(ids(0, 10).filter(id => !failed.includes(id)))
    expect(bodySource(during)).toMatchObject({ status: 'failed', failed: 1, indexed: 9 })
    expect(shared()).toMatchObject({ layout: CLEAN, meta: expect.arrayContaining([expect.objectContaining({ key: 'mark' })]) })
    expect(shared().refs).toHaveLength(10)
    lift()
    // Failed refs are retried: the next search indexes it.
    expect(search().items.map(e => e.id).sort()).toEqual(ids(0, 10))
  })
})
