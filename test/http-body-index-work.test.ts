// What a body search costs once the index is built, counted rather than
// timed: no statement may scan body_fts (FTS5 finds rows only by MATCH or
// rowid; a filter on anything else reads every document), and a search after
// the first may re-derive nothing for rows already linked — no inline body
// scanned or hashed again, no source row read except the refs that are still
// missing (they are retried on every search, by design).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { seedBodySearchProject, type ProjectShape } from './helpers/body-search-project'
import { parseQuery } from '../src/core/query/contract'
import { cost, savedBody, savedResponse } from './helpers/body-index-work'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let idx: typeof import('../src/core/http-body-index')
let getReadonlyDB: typeof import('../src/core/db').getReadonlyDB
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
const sqlite = requires('better-sqlite3')
if (sqlite.ok) {
  const db = await import('../src/core/db')
  initDB = db.initDB; closeDB = db.closeDB; getReadonlyDB = db.getReadonlyDB
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
  executeEventQuery = (await import('../src/core/db/event-queries')).executeEventQuery
  idx = await import('../src/core/http-body-index')
}

const SHAPE: ProjectShape = { shell: 300, responses: 600, escapedEvery: 3, missing: 20, rareEvery: 60 }
let dir = ''

function search(text: string) {
  const outcome = parseQuery(text)
  if (!outcome.ok) throw new Error(outcome.reason)
  return executeEventQuery({ parsed: outcome.parsed, filter: {}, limit: 50 })
}

/** Every statement prepared on the body index, and source rows the index read. */
function watch(): { sql: Set<string>; rows: () => number } {
  const sql = new Set<string>()
  let rows = 0
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
    const s = prepare.call(this, text)
    if (this.name.endsWith('http-body-index.db')) sql.add(text)
    if (/^SELECT id,data,agent_type/.test(text)) {
      const iterate = s.iterate.bind(s), get = s.get.bind(s)
      ;(s as unknown as { iterate: (...a: unknown[]) => unknown }).iterate = function* (...a: unknown[]) { for (const r of iterate(...a)) { rows++; yield r } }
      ;(s as unknown as { get: (...a: unknown[]) => unknown }).get = (...a: unknown[]) => { const r = get(...a); if (r) rows++; return r }
    }
    return s
  })
  return { sql, rows: () => rows }
}

sqlite.describe('body search work on a captured project', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-work-')); initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('scans no body_fts document per ref, and a second search re-derives nothing for linked rows', () => {
    const { missingIds, escaped } = seedBodySearchProject(SHAPE)
    const seen = watch()
    const first = search('RAREBODYWORD')
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.bodyCoverage?.sources?.find(s => s.kind === 'body')).toEqual(expect.objectContaining({ indexed: escaped, missing: missingIds.length }))

    const workBefore = idx._inlineRefWork(), rowsBefore = seen.rows()
    const second = search('稀有詞')
    expect(second.items.length).toBeGreaterThan(0)
    expect(idx._inlineRefWork() - workBefore).toBe(0)
    // The only source rows read: the events whose saved body is missing, retried.
    expect(seen.rows() - rowsBefore).toBe(missingIds.length)
    expect(second.bodyCoverage).toEqual(expect.objectContaining({ revision: expect.any(String) }))

    // Removal paths, then a full walk, prepare their statements too.
    const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    const anySha = (index.prepare('SELECT sha256 FROM body_event_refs WHERE raw_docs+decoded_docs>0 LIMIT 1 -- the test picking a ref').get() as { sha256: string }).sha256
    index.close()
    idx.pruneHttpBodyIndex(anySha, dir)
    idx.pruneSavedFileIndex(path.join(dir, 'artifacts', 'none'), dir)
    search('common')
    // A saved body that changes after it was indexed: its documents are
    // dropped by rowid, from the counts its ref row records.
    const ref = savedBody(dir, '{"w":"CHANGINGWORD"}')
    savedResponse('changing', { response_body_ref: ref })
    search('CHANGINGWORD')
    fs.writeFileSync(path.join(dir, 'http-bodies', ref.file), '{"w":"CHANGEDWORD!"}')
    expect(search('CHANGINGWORD').items).toEqual([])

    // How each statement that reads documents, or the counts that say where a
    // ref's documents are, finds its rows, stated positively: body_fts by MATCH
    // or by rowid equality, body_event_refs by its id, its (event, slot) key
    // or its sha256 index. Any other access (a full or descending scan of
    // body_fts, a rowid range, a scan of the refs) is a read of every document
    // or of every ref. Two exceptions read every ref, as they did before
    // documents were addressed by rowid: the full walk's sweep of refs no row
    // has any more, once per walk by design, and the prune of one saved
    // artifact or transcript, which compares every non-body ref's resolved
    // path. TEMP extras live on the index's own connection and are not
    // planned here.
    const plans = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try {
      const SWEEP = /^SELECT ref,raw_docs,decoded_docs FROM body_event_refs WHERE NOT EXISTS/
      const SAVED_FILE = /^SELECT ref,raw_docs,decoded_docs,file FROM body_event_refs WHERE kind<>'body'$/
      const reads = [...seen.sql].filter(text => /\bbody_fts\b|\braw_docs\b/.test(text) && !/body_x_|-- the test/.test(text) && !/^\s*(INSERT|CREATE|DROP)/i.test(text))
      const bad = reads.filter(text => !SWEEP.test(text) && !SAVED_FILE.test(text)).flatMap(text => {
        const named = [...new Set(text.match(/@\w+/g) ?? [])]
        const args = named.length ? [Object.fromEntries(named.map(n => [n.slice(1), 'x']))] : (text.match(/\?/g) ?? []).map(() => 'x')
        const plan = plans.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...args) as { detail: string }[]
        return plan.filter(p => /\bbody_(fts|event_refs)\b|^(SCAN|SEARCH) r\b/.test(p.detail)).filter(p => !(
          /^SCAN body_fts VIRTUAL TABLE INDEX 0:M\d*$/.test(p.detail)
          || /^SCAN body_fts VIRTUAL TABLE INDEX 0:=$/.test(p.detail)
          || /^SEARCH (body_event_refs|r) USING (INTEGER PRIMARY KEY \(rowid=\?\)|(COVERING )?INDEX (sqlite_autoindex_body_event_refs_1|body_event_refs_sha256) \()/.test(p.detail)
        )).map(p => `${p.detail}  ←  ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      })
      expect(bad).toEqual([])
      // FTS5 ignores a rowid bound as a JS number (REAL) beside MATCH and
      // returns every match: no statement binds one. A search finds its refs
      // from each match's own integer rowid instead.
      expect(reads.filter(t => /\bMATCH\b/.test(t) && /\browid\s*(=|<|>|BETWEEN|IN)\s*(\?|@|CAST)/i.test(t))).toEqual([])
      // Not vacuous: the MATCH, the rowid delete, the counts by (event, slot)
      // and by sha256, and the sweep were planned.
      const all = reads.map(text => text.replace(/\s+/g, ' '))
      expect(all.some(t => /body_fts MATCH/.test(t)) && all.some(t => /DELETE FROM body_fts WHERE rowid=\?/.test(t))
        && all.some(t => /raw_docs.* FROM body_event_refs WHERE event_id=\? AND slot=\?/.test(t)) && all.some(t => /raw_docs.* FROM body_event_refs WHERE sha256=\?/.test(t))
        && all.some(t => SWEEP.test(t))).toBe(true)
    } finally { plans.close() }
  })

  it('coverage read from the index is the answer computed from the source rows, for an event whose two bodies are the same bytes too', () => {
    const { escaped } = seedBodySearchProject(SHAPE)
    const same = savedBody(dir, `{"echo":"${'SAMEBYTES '.repeat(500)}"}`)
    savedResponse('echo', { request_body_ref: same, response_body_ref: same })
    expect(search('SAMEBYTES').items.map(e => e.id)).toEqual(['echo'])
    // What that search asked: a snapshot at the current maxima. The index
    // describes exactly those rows, so coverage reads no source row.
    const now = readActivitySnapshot(getReadonlyDB())
    const fromIndex = cost(() => idx.bodySearchCoverage(now))
    expect(fromIndex.rows).toBe(0)
    // Nothing that changes a ref, but the index no longer vouches for the
    // rows: coverage is computed from every source row instead.
    idx.pruneSavedFileIndex(path.join(dir, 'artifacts', 'none'), dir)
    const fromSource = cost(() => idx.bodySearchCoverage(now))
    expect(fromSource.rows).toBeGreaterThan(escaped)
    expect(fromSource.result).toEqual(fromIndex.result)
    // Two refs, one per body, on both paths.
    expect(fromSource.result.sources!.find(s => s.kind === 'body')!.indexed).toBe(escaped + 2)
    // Live, after the next search (which asked under a snapshot): the same
    // state, so from the index again, and the same answer.
    search('SAMEBYTES')
    const live = cost(() => idx.bodySearchCoverage())
    expect(live.rows).toBe(0)
    expect(live.result).toEqual({ ...fromIndex.result, boundary: undefined })
  })
})
