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
    const anySha = (index.prepare('SELECT sha256 FROM body_docs LIMIT 1').get() as { sha256: string }).sha256
    index.close()
    idx.pruneHttpBodyIndex(anySha, dir)
    idx.pruneSavedFileIndex(path.join(dir, 'artifacts', 'none'), dir)
    search('common')

    const plans = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try {
      const scans = [...seen.sql].filter(text => /body_fts/.test(text) && !/^\s*(INSERT|CREATE|DROP)/i.test(text)).flatMap(text => {
        const params = (text.match(/\?/g) ?? []).map(() => 'x')
        const plan = plans.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[]
        return plan.filter(p => /SCAN body_fts VIRTUAL TABLE INDEX 0:$/.test(p.detail)).map(() => text)
      })
      expect(scans).toEqual([])
      expect([...seen.sql].some(text => /body_fts/.test(text))).toBe(true)
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
  })
})
