// The export worker opens the project read-only and holds one read
// transaction for the whole export (export-worker.ts), so its view of the
// source rows can fall behind what main has indexed since. Such a connection
// must never walk, prune or move the shared index's watermark: it answers from
// the shared index where that vouches for its view, and from its own TEMP
// tables elsewhere. Main meanwhile keeps finding the bodies it indexed:
// `eventIdsReferencingBody`, which /api/http-body/<sha> goes through, must not
// lose them while an export runs.
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parsed, savedBody, savedResponse } from './helpers/body-index-work'
import { openFrozenReader, type FrozenReader } from './helpers/frozen-export-reader'
import { getDB } from '../src/core/db/index'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
}
let dir = '', reader: FrozenReader | null = null
const search = (text: string) => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 1000 })

/** What the shared index holds, read through a connection of its own. */
function shared(): { refs: number; docs: number; mark: unknown } {
  const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
  try {
    const n = (sql: string) => (index.prepare(sql).get() as { n: number }).n
    const mark = index.prepare("SELECT value FROM body_index_meta WHERE key='mark'").get() as { value: string } | undefined
    return { refs: n('SELECT count(*) AS n FROM body_event_refs'), docs: n('SELECT count(*) AS n FROM body_docs'), mark: mark && JSON.parse(mark.value).tiers }
  } finally { index.close() }
}
const chainedBody = (id: string, text: string): string => {
  const ref = savedBody(dir, text)
  getDB().prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
    VALUES (?,9000003,'project','capture','operator','scanner','http_response','host',?,9000003,'hash')`).run(id, JSON.stringify({ subtype: 'http_response', response_body_ref: ref }))
  return ref.sha256
}

/** A logged scanner response whose saved body (and nothing else) holds
 *  `word`; `at` is its created_at, the order retention deletes in. */
const loggedBody = (id: string, word: string, at: number): void => {
  const ref = savedBody(dir, `{"v":"${word} ${id}"}`)
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,?,'project','capture','operator','scanner','http_response','host',?,?)`).run(id, at, JSON.stringify({ subtype: 'http_response', url: 'http://t.test/', response_body_ref: ref }), at)
}
const dnsRow = (id: string, at: number): void => {
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,?,'project','capture','operator','scanner','dns_query','host',?,?)`).run(id, at, JSON.stringify({ subtype: 'dns_query', name: 'x.test' }), at)
}
/** What retention runs on the logged tier (retention.ts sweepLoggedTier). */
const retain = (before: number, limit: number): void => {
  getDB().prepare(`DELETE FROM events_logged WHERE rowid IN (SELECT rowid FROM events_logged WHERE created_at < ? LIMIT ${limit})`).run(before)
}
const ids = (prefix: string, from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `${prefix}-${from + i}`).sort()

sqlite.describe('a read-only connection whose view is behind the shared index', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-frozen-')); db.initDB(dir) })
  afterEach(async () => { await reader?.close(); reader = null; idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it.each(['logged', 'chained'] as const)('behind in the %s tier: answers its snapshot, and leaves the shared index and main as they were', async tier => {
    const old = Array.from({ length: 5 }, (_, i) => { savedResponse(`old-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha old${i}"}`) }); return `old-${i}` })
    search('alpha')
    reader = await openFrozenReader(dir, 'project')
    // While the export runs, capture goes on and main searches.
    const added: Array<{ id: string; sha256: string }> = []
    for (let i = 0; i < 20; i++) {
      const id = `new-${i}`, text = `{"n":"alpha new${i}"}`
      if (tier === 'chained') added.push({ id, sha256: chainedBody(id, text) })
      else { const ref = savedBody(dir, text); savedResponse(id, { response_body_ref: ref }); added.push({ id, sha256: ref.sha256 }) }
    }
    expect(search('alpha').items).toHaveLength(25)
    const before = shared()
    expect(before).toMatchObject({ refs: 25, docs: 25 })

    for (let round = 0; round < 3; round++) {
      const answer = await reader.search('alpha')
      expect(answer.ids).toEqual(old)
      expect(answer.coverage).toMatchObject({ status: 'covered', indexed: 5 })
      // Its view is vouched for by the shared index: no row of it is read again.
      expect(answer.rows).toBe(0)
      expect(shared()).toEqual(before)
      for (const { id, sha256 } of added) expect(idx.eventIdsReferencingBody(sha256, dir)).toEqual([id])
    }
    expect(search('alpha').items).toHaveLength(25)
  }, 30_000)

  it('rows its view has and the shared index does not yet: read once, into its own tables', async () => {
    for (let i = 0; i < 5; i++) savedResponse(`old-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha old${i}"}`) })
    search('alpha')
    // Main has not searched since these were written.
    for (let i = 0; i < 3; i++) savedResponse(`unindexed-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha unindexed${i}"}`) })
    const before = shared()
    reader = await openFrozenReader(dir, 'project')
    const first = await reader.search('alpha'), second = await reader.search('alpha')
    expect(first.ids).toHaveLength(8)
    expect(first.coverage).toMatchObject({ status: 'covered', indexed: 8 })
    expect({ first: first.rows, second: second.rows }).toEqual({ first: 3, second: 0 })
    expect(shared()).toEqual(before)
  }, 30_000)

  // Retention deletes the oldest logged rows after the reader opened: the
  // shared index no longer describes rows the reader still sees.
  it('after retention deleted rows its view still has: answers every row it sees', async () => {
    for (let i = 0; i < 10; i++) loggedBody(`old-${i}`, 'alpha', 1000 + i)
    search('alpha')
    reader = await openFrozenReader(dir, 'project')
    for (let i = 0; i < 3; i++) loggedBody(`new-${i}`, 'alpha', 2000 + i)
    retain(1005, 1000)
    expect(search('alpha').items.map(e => e.id).sort()).toEqual([...ids('old', 5, 10), ...ids('new', 0, 3)].sort())
    const before = shared()
    const answer = await reader.search('alpha')
    expect(answer.ids).toEqual(ids('old', 0, 10))
    expect(answer.coverage).toMatchObject({ status: 'covered', indexed: 10 })
    expect(shared()).toEqual(before)
  }, 30_000)

  // events_logged has no AUTOINCREMENT: once retention removed every logged
  // row, new capture starts again at rowid 1.
  it('after rowid reuse below its view: answers its own rows, not the new ones at the same rowids', async () => {
    for (let i = 0; i < 3; i++) loggedBody(`old-${i}`, 'alpha', 1000 + i)
    search('alpha')
    reader = await openFrozenReader(dir, 'project')
    retain(2000, 1000)
    for (let i = 0; i < 3; i++) dnsRow(`dns-${i}`, 3000 + i)
    for (let i = 0; i < 5; i++) loggedBody(`new-${i}`, 'alpha', 4000 + i)
    expect(search('alpha').items.map(e => e.id).sort()).toEqual(ids('new', 0, 5))
    const answer = await reader.search('alpha')
    expect(answer.ids).toEqual(ids('old', 0, 3))
    expect(answer.coverage).toMatchObject({ status: 'covered', indexed: 3 })
  }, 30_000)

  it('pages through more than one page after retention, as a multi-page export plan does', async () => {
    getDB().transaction(() => { for (let i = 0; i < 1100; i++) loggedBody(`old-${String(i).padStart(4, '0')}`, 'alpha', 1000 + i) })()
    search('alpha')
    reader = await openFrozenReader(dir, 'project')
    getDB().transaction(() => { for (let i = 0; i < 3; i++) loggedBody(`new-${i}`, 'alpha', 9000 + i) })()
    retain(1005, 1000)
    search('alpha')
    const paged = await reader.pages('alpha', 1000)
    expect(paged.error).toBeUndefined()
    expect(paged.ids).toHaveLength(1100)
  }, 60_000)

  it('re-verifies what main has not: a body changed or gone since main last searched', async () => {
    const refs = Array.from({ length: 3 }, (_, i) => { const ref = savedBody(dir, `{"n":"alpha body${i}"}`); savedResponse(`e-${i}`, { response_body_ref: ref }); return ref })
    search('alpha')
    fs.writeFileSync(path.join(dir, 'http-bodies', refs[0].file), '{"n":"gamma body0"}')
    fs.rmSync(path.join(dir, 'http-bodies', refs[1].file))
    reader = await openFrozenReader(dir, 'project')
    const answer = await reader.search('alpha')
    expect(answer.ids).toEqual(['e-2'])
    expect(answer.coverage).toMatchObject({ indexed: 1, missing: 1 })
    expect(answer.coverage.status).not.toBe('covered')
  }, 30_000)

  it('the shared index writers do nothing on a read-only connection', async () => {
    const ref = savedBody(dir, '{"n":"alpha one"}')
    savedResponse('one', { response_body_ref: ref })
    search('alpha')
    const before = shared()
    expect(before.mark).toBeTruthy()
    reader = await openFrozenReader(dir, 'project')
    await reader.call('pruneHttpBodyIndex', ref.sha256, dir)
    await reader.call('pruneSavedFileIndex', path.join(dir, 'artifacts', 'none'), dir)
    await reader.call('linkHttpBodyEvent', { id: 'ghost', data: { subtype: 'http_response', response_body_ref: savedBody(dir, '{"n":"ghost"}') } }, dir)
    expect(shared()).toEqual(before)
  }, 30_000)

  it('is opened by the function export-worker.ts opens the project with', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../src/main/services/export-worker.ts'), 'utf8')
    expect(worker).toMatch(/openFrozenProjectDB\(task\.project\.path, task\.project\.id\)/)
    expect(worker).not.toMatch(/openReadonlyProjectDB|initDB\(|exec\('BEGIN'\)/)
  })

  it('a replaced database: the reader answers its own rows and writes nothing; main rebuilds', async () => {
    for (let i = 0; i < 5; i++) savedResponse(`gone-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha gone${i}"}`) })
    search('alpha')
    idx.closeHttpBodyIndex(); db.closeDB()
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `timeline.db${suffix}`), { force: true })
    db.initDB(dir)
    for (let i = 0; i < 3; i++) savedResponse(`fresh-${i}`, { response_body_ref: savedBody(dir, `{"n":"alpha fresh${i}"}`) })
    const before = shared()
    expect(before).toMatchObject({ refs: 5 })
    reader = await openFrozenReader(dir, 'project')
    const answer = await reader.search('alpha')
    expect(answer.ids).toEqual(['fresh-0', 'fresh-1', 'fresh-2'])
    expect(answer.coverage).toMatchObject({ status: 'covered', indexed: 3 })
    expect(shared()).toEqual(before)
    expect(search('alpha').items.map(e => e.id).sort()).toEqual(['fresh-0', 'fresh-1', 'fresh-2'])
    expect(shared()).toMatchObject({ refs: 3, docs: 3, mark: [{ n: 0 }, { n: 3 }] })
  }, 30_000)
})
