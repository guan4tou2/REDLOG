import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { searchHttpBodyEventIds, bodySearchCoverage, closeHttpBodyIndex, linkHttpBodyEvent, extractionFingerprint } from '../src/core/http-body-index'
import type { ExportSnapshot } from '../src/core/export-plan'

// What the persisted index trusts must never let a search miss rows while its
// coverage says the dataset is covered. These come from an adversarial review
// of the v8 index (#695): each one was a way to leave a gap the index could not
// see, while coverage reported `covered`.

let dir = ''
const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const run of cleanups.splice(0)) { try { run() } catch { /* already closed */ } }
  closeHttpBodyIndex(); closeDB(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''
})
type Tier = 'events' | 'events_logged'
function insert(id: string, data: Record<string, unknown>, tier: Tier = 'events'): void {
  getDB().prepare(`INSERT INTO ${tier} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at${tier === 'events' ? ',hash' : ''})
    VALUES (?,1,'project','capture','operator','scanner','http_response','host',?,?${tier === 'events' ? ",'hash'" : ''})`).run(id, JSON.stringify({ subtype: 'http_response', ...data }), Number(id.replace(/\D/g, '')) || 1)
}
function bodyEvent(id: string, text: string, tier: Tier = 'events'): { sha256: string; file: string; size: number; encoding: 'text' } {
  const bytes = Buffer.from(text), sha256 = createHash('sha256').update(bytes).digest('hex'), file = `${sha256}.body`
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true }); fs.writeFileSync(path.join(dir, 'http-bodies', file), bytes)
  const ref = { sha256, file, size: bytes.length, encoding: 'text' as const }
  insert(id, { response_body_ref: ref }, tier)
  return ref
}
const project = (): void => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-integrity-')); initDB(dir) }
const snap = (): ExportSnapshot => {
  const max = (t: string): number => (getDB().prepare(`SELECT coalesce(max(rowid),0) AS m FROM ${t}`).get() as { m: number }).m
  return { chainedMaxRowId: max('events'), loggedMaxRowId: max('events_logged'), takenAt: 1 }
}
const bodyStatus = (s?: ExportSnapshot): string => bodySearchCoverage(s).sources!.find(x => x.kind === 'body')!.status
function index<T>(run: (db: Database.Database) => T): T {
  const db = new Database(path.join(dir, 'http-body-index.db'))
  try { return run(db) } finally { db.close() }
}
const walkMax = (): number => index(db => (JSON.parse((db.prepare("SELECT value FROM body_index_meta WHERE key='walk'").get() as { value: string }).value) as { tiers: Array<{ max: number }> }).tiers[0].max)

describe('body index integrity', () => {
  // P2: another writer of the index (the export worker) committed between this
  // search reading the watermark and opening its transaction; the search then
  // trusted the stale watermark and never linked the rows in between.
  it('reads the watermark under the write lock: a commit just before it is seen, and nothing is lost', () => {
    project()
    for (let i = 1; i <= 10; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    for (let i = 11; i <= 15; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    for (let i = 16; i <= 17; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    // A full walk at boundary 10, committed on another connection just as this
    // search starts its index transaction.
    let armed = true
    const transaction = Database.prototype.transaction
    vi.spyOn(Database.prototype, 'transaction').mockImplementation(function (this: Database.Database, fn: never) {
      if (armed && this.name.endsWith('http-body-index.db')) {
        armed = false
        const id10 = (getDB().prepare('SELECT id FROM events WHERE rowid=10').get() as { id: string }).id
        index(w => w.transaction(() => {
          w.prepare(`DELETE FROM body_fts WHERE event_id IN (SELECT event_id FROM body_event_refs WHERE tier='events' AND "row">10)`).run()
          w.prepare(`DELETE FROM body_event_refs WHERE tier='events' AND "row">10`).run()
          w.prepare("UPDATE body_index_meta SET value=? WHERE key='walk'").run(JSON.stringify({ tiers: [{ n: 10, max: 10, idAtMax: id10 }, { n: 0, max: 0, idAtMax: null }], latest: [] }))
        })())
      }
      return transaction.call(this, fn)
    })
    searchHttpBodyEventIds('alpha', dir)
    vi.restoreAllMocks()
    expect(searchHttpBodyEventIds('work12', dir)).toEqual(['w12'])
    expect(searchHttpBodyEventIds('alpha', dir)).toHaveLength(17)
    closeHttpBodyIndex()
    expect(searchHttpBodyEventIds('work12', dir)).toEqual(['w12'])
    expect(bodyStatus()).toBe('covered')
  })

  // The export worker reads the project inside BEGIN, so it sees an older
  // dataset than the main process, and writes the same index file. A
  // connection with an older view must neither prune the rows above what it
  // sees nor move the watermark back.
  it('a reader with an older view of the project neither prunes newer rows nor lowers the watermark', async () => {
    project()
    for (let i = 1; i <= 10; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    // A second, independent copy of the modules: its own project connection
    // and its own index connection, as in the export worker.
    vi.resetModules()
    const workerDb = await import('../src/core/db/index')
    const workerIndex = await import('../src/core/http-body-index')
    workerDb.openReadonlyProjectDB(dir, 'project')
    workerDb.getDB().exec('BEGIN')
    workerDb.getDB().prepare('SELECT count(*) FROM events').get()
    cleanups.push(() => { workerIndex.closeHttpBodyIndex(); workerDb.closeDB() })
    // The main process records and searches past what the worker can see.
    for (let i = 11; i <= 15; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    expect(walkMax()).toBe(15)
    const older: ExportSnapshot = { chainedMaxRowId: 10, loggedMaxRowId: 0, takenAt: 1 }
    expect(workerIndex.searchHttpBodyEventIds('alpha', dir, false, older)).toHaveLength(10)
    expect(workerIndex.bodySearchCoverage(older).indexed).toBe(10)
    expect(walkMax()).toBe(15)
    expect(index(db => (db.prepare(`SELECT count(DISTINCT event_id) AS n FROM body_event_refs WHERE "row">10`).get() as { n: number }).n)).toBe(5)
    expect(searchHttpBodyEventIds('work12', dir)).toEqual(['w12'])
    expect(bodyStatus()).toBe('covered')
  })

  // P3: ingest links a row inside a project transaction that then rolls back.
  // The linked index row sits above the watermark with no source row.
  it('drops an index row whose source row was rolled back', () => {
    project()
    for (let i = 1; i <= 3; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    expect(() => getDB().transaction(() => {
      const ref = bodyEvent('w4', 'alpha ghostword')
      linkHttpBodyEvent({ id: 'w4', data: { subtype: 'http_response', response_body_ref: ref }, agentType: 'scanner' }, dir)
      throw new Error('rolled back')
    })()).toThrow('rolled back')
    expect(searchHttpBodyEventIds('ghostword', dir)).toEqual([])
    expect(index(db => db.prepare("SELECT count(*) AS n FROM body_event_refs WHERE event_id='w4'").get())).toEqual({ n: 0 })
    expect(bodySearchCoverage().indexed).toBe(3)
  })

  // P1 and the safety net: a ref row missing below the watermark (any cause the
  // index does not know about). Coverage compares a count from the project with
  // one from the index; a mismatch is reported, and repaired by the next search.
  it('reports a gap below the watermark as not covered, and the next search repairs it', () => {
    project()
    for (let i = 1; i <= 5; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    index(db => { db.prepare("DELETE FROM body_fts WHERE event_id='w2'").run(); db.prepare("DELETE FROM body_event_refs WHERE event_id='w2'").run() })
    closeHttpBodyIndex()
    const gap = bodySearchCoverage()
    expect(gap.sources!.find(x => x.kind === 'body')!.status).not.toBe('covered')
    expect(gap.pending).toBeGreaterThanOrEqual(1)
    expect(searchHttpBodyEventIds('work2', dir)).toEqual(['w2'])
    expect(bodyStatus()).toBe('covered')
  })

  it('a bounded coverage read sees a gap inside its boundary too', () => {
    project()
    for (let i = 1; i <= 5; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    const s = snap()
    searchHttpBodyEventIds('alpha', dir, false, s)
    index(db => { db.prepare("DELETE FROM body_event_refs WHERE event_id='w4'").run() })
    expect(bodyStatus(s)).not.toBe('covered')
  })

  // P1, the cause: what an Event's refs are is decided by code, not by the
  // schema. A change to those rules without a version bump left every row
  // already walked as the old rules made it.
  it('walks everything again when the extraction rules the index was built with change', () => {
    project()
    for (let i = 1; i <= 5; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    index(db => {
      db.prepare("UPDATE body_index_meta SET value='an older build' WHERE key='extraction'").run()
      db.prepare("DELETE FROM body_event_refs WHERE event_id='w3'").run()
    })
    closeHttpBodyIndex()
    expect(searchHttpBodyEventIds('work3', dir)).toEqual(['w3'])
    expect(index(db => db.prepare("SELECT value FROM body_index_meta WHERE key='extraction'").get())).toEqual({ value: extractionFingerprint() })
  })

  // P5: a coverage sum changed with the row count intact.
  it('does not serve a tampered coverage count whose row count still matches', () => {
    project()
    for (let i = 1; i <= 5; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    const honest = bodySearchCoverage()
    index(db => db.prepare("UPDATE body_coverage SET n=n+7 WHERE kind='body' AND status='indexed'").run())
    expect(bodySearchCoverage()).toEqual(honest)
  })

  // Another connection holding the index's write lock (a long export-worker
  // walk) must not fail a search, and coverage must not call what it could not
  // bring up to date covered.
  it('answers from the index as it stands while another writer holds it, and says so', () => {
    project()
    for (let i = 1; i <= 5; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    searchHttpBodyEventIds('alpha', dir)
    bodyEvent('w6', 'alpha work6')
    const holder = new Database(path.join(dir, 'http-body-index.db'))
    cleanups.push(() => holder.close())
    holder.prepare('BEGIN IMMEDIATE').run()
    expect(searchHttpBodyEventIds('alpha', dir)).toHaveLength(5)
    expect(bodyStatus()).not.toBe('covered')
    holder.prepare('ROLLBACK').run()
    expect(searchHttpBodyEventIds('alpha', dir)).toHaveLength(6)
    expect(bodyStatus()).toBe('covered')
  })
})

// The fingerprint is derived from the extraction rules themselves, so a change
// to any of the lists cannot leave it as it was.
describe('extraction fingerprint', () => {
  const fingerprintWith = async (mock: () => void): Promise<string> => {
    vi.resetModules(); mock()
    try { return (await import('../src/core/http-body-index')).extractionFingerprint() }
    finally { vi.doUnmock('../src/core/http-body-store'); vi.doUnmock('../src/core/body-source'); vi.doUnmock('../src/core/content-contract'); vi.resetModules() }
  }
  it('changes when the body ref fields, the saved-file refs or the source predicate change', async () => {
    const base = await fingerprintWith(() => {})
    expect(await fingerprintWith(() => {})).toBe(base)
    const fields = await fingerprintWith(() => vi.doMock('../src/core/http-body-store', async (original) => {
      const actual = await original<typeof import('../src/core/http-body-store')>()
      return { ...actual, BODY_REF_FIELDS: [...actual.BODY_REF_FIELDS, 'extra_body_ref'] }
    }))
    const saved = await fingerprintWith(() => vi.doMock('../src/core/body-source', async (original) => {
      const actual = await original<typeof import('../src/core/body-source')>()
      return { ...actual, savedFileRefs: (event: Parameters<typeof actual.savedFileRefs>[0]) => actual.savedFileRefs(event).slice(0, 1) }
    }))
    const predicate = await fingerprintWith(() => vi.doMock('../src/core/content-contract', async (original) => {
      const actual = await original<typeof import('../src/core/content-contract')>()
      return { ...actual, BODY_SOURCE_PREDICATE: `${actual.BODY_SOURCE_PREDICATE} OR 0` }
    }))
    expect(new Set([base, fields, saved, predicate]).size).toBe(4)
  })
})
