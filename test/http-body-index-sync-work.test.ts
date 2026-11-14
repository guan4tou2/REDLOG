// What keeping the body index current costs while capture runs, counted
// rather than timed: source rows the index reads (each is a JSON parse and a
// link), and inline bodies scanned for escapes. Rows added since the last
// search cost work for those rows, whichever surface asks next — Search pages
// under a fresh dataset snapshot, the Timeline asks live, "earlier" counts
// under the snapshot of a page taken before — and a row with no body, however
// it was written, costs nothing.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { seedBodySearchProject, type ProjectShape } from './helpers/body-search-project'
import { cost, parsed, shellRow, escapedResponse, escapeNonAscii, savedBody, bodySource } from './helpers/body-index-work'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
let ingest: typeof import('../src/core/ingest').ingest
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
  ingest = (await import('../src/core/ingest')).ingest
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
}

// A few thousand rows: enough that a walk of the project and a walk of one
// new row cannot be mistaken for each other.
const SHAPE: ProjectShape = { shell: 500, responses: 1500, escapedEvery: 3, missing: 4, rareEvery: 100 }
/** The missing saved bodies are retried by every search, by design. */
const RETRIED = SHAPE.missing
let dir = ''
/** Search as the Search panel asks: a page under a fresh dataset snapshot. */
const search = (text: string) => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 50 })

sqlite.describe('body index work while capture runs', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-sync-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('one new row with no body costs no source row at the next search', () => {
    seedBodySearchProject(SHAPE)
    search('RAREBODYWORD')
    expect(cost(() => search('RAREBODYWORD'))).toMatchObject({ rows: RETRIED, inline: 0 })
    shellRow('shell-new')
    expect(cost(() => search('RAREBODYWORD'))).toMatchObject({ rows: RETRIED, inline: 0 })
  })

  it('one new response costs that row, and is found', () => {
    seedBodySearchProject(SHAPE)
    search('RAREBODYWORD')
    escapedResponse('res-new', 'FRESHWORDX')
    const { rows, inline, result } = cost(() => search('新詞'))
    expect({ rows, inline }).toEqual({ rows: RETRIED + 1, inline: 1 })
    expect(result.items.map(e => e.id)).toEqual(['res-new'])
    expect(bodySource(result)?.status).toBe('unavailable')
  })

  it('a live count or match between two searches walks nothing, and neither does the search after it', () => {
    seedBodySearchProject(SHAPE)
    search('RAREBODYWORD')
    const q = parsed('RAREBODYWORD')
    expect(cost(() => queries.countEvents({ parsed: q, filter: {} }))).toMatchObject({ rows: RETRIED, inline: 0 })
    expect(cost(() => search('RAREBODYWORD'))).toMatchObject({ rows: RETRIED, inline: 0 })
    expect(cost(() => queries.matchEventIds({ parsed: q, filter: {}, ids: ['res-100'] }))).toMatchObject({ rows: RETRIED, inline: 0 })
    // "earlier": a count under the page's snapshot after new rows arrived.
    const page = search('RAREBODYWORD')
    const before = readActivitySnapshot(db.getReadonlyDB())
    shellRow('shell-later'); escapedResponse('res-later', 'LATERWORDX')
    expect(cost(() => search('LATERWORDX'))).toMatchObject({ rows: RETRIED + 1, inline: 1 })
    expect(cost(() => queries.countEvents({ parsed: q, filter: {}, snapshot: before }))).toMatchObject({ rows: RETRIED, inline: 0 })
    expect(cost(() => queries.countEvents({ parsed: q, filter: {} }))).toMatchObject({ rows: RETRIED, inline: 0 })
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('a body-less scanner event ingested during capture costs nothing at the next search', () => {
    seedBodySearchProject(SHAPE)
    search('RAREBODYWORD')
    ingest({ agentType: 'scanner', engagementId: 'project', operatorId: 'operator', data: { subtype: 'http_request_start', flow_id: 'fx', method: 'GET', url: 'http://new.test/' } })
    expect(cost(() => search('RAREBODYWORD'))).toMatchObject({ rows: RETRIED, inline: 0 })
    expect(cost(() => queries.countEvents({ parsed: parsed('RAREBODYWORD'), filter: {} }))).toMatchObject({ rows: RETRIED, inline: 0 })
  })

  it('ingest links a saved body without scanning an inline one, and the next search costs that row alone', () => {
    seedBodySearchProject(SHAPE)
    search('RAREBODYWORD')
    const ref = savedBody(dir, '{"saved":"SAVEDNEWWORD"}')
    const text = escapeNonAscii(JSON.stringify({ inline: 'INLINENEWWORD 新詞' }))
    const linked = cost(() => ingest({ agentType: 'scanner', engagementId: 'project', operatorId: 'operator', data: {
      subtype: 'http_response', flow_id: 'fy', url: 'http://new.test/', response_body_ref: ref,
      request_body: { data: text, encoding: 'text', size: Buffer.byteLength(text), truncated: false, content_type: 'application/json' } } }))
    // The inline body's decoded text is the next search's work, not capture's.
    expect(linked.inline).toBe(0)
    const id = linked.result.event!.id
    const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try { expect(index.prepare('SELECT file FROM body_event_refs WHERE event_id=?').all(id)).toEqual([{ file: ref.file }]) } finally { index.close() }
    const { rows, inline, result } = cost(() => search('SAVEDNEWWORD 新詞'))
    expect({ rows, inline }).toEqual({ rows: RETRIED + 1, inline: 1 })
    expect(result.items.map(e => e.id)).toEqual([id])
  })
})
