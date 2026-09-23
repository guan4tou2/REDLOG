import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseQuery } from '../src/core/query/contract'
import type { EventFilter } from '../src/core/db/event-queries'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let ingest: typeof import('../src/core/ingest').ingest
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let pruneHttpBodyIndex: typeof import('../src/core/http-body-index').pruneHttpBodyIndex
let storeBody: typeof import('../src/core/http-body-store').storeBody
let insertEvent: typeof import('../src/core/db/events').insertEvent
let available = false

try {
  const db = await import('../src/core/db')
  const events = await import('../src/core/db/events')
  const ing = await import('../src/core/ingest')
  const idx = await import('../src/core/http-body-index')
  const bodies = await import('../src/core/http-body-store')
  initDB = db.initDB
  closeDB = db.closeDB
  ingest = ing.ingest
  executeEventQuery = events.executeEventQuery
  closeHttpBodyIndex = idx.closeHttpBodyIndex
  pruneHttpBodyIndex = idx.pruneHttpBodyIndex
  storeBody = bodies.storeBody
  insertEvent = events.insertEvent
  available = true
} catch { /* native SQLite unavailable */ }


// Spec 026: Search's paged text query is the query contract. The pagination,
// filter and body-search assertions below were written against the retired
// `searchEventsPage`; they run unchanged against the contract through this.
function searchPage(opts: EventFilter & { query: string; limit?: number; cursor?: string | null }) {
  const outcome = parseQuery(opts.query)
  if (!outcome.ok) throw new Error(`test query did not parse: ${outcome.reason}`)
  const { query: _query, limit, cursor, ...filter } = opts
  return executeEventQuery({ parsed: outcome.parsed, filter, limit, cursor })
}

const describeDB = available ? describe : describe.skip
let dir: string

describeDB('HTTP body search', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-search-'))
    initDB(dir)
  })
  afterEach(() => {
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function response(id: string, marker: string, targetId = 'api.test'): string {
    const result = ingest({
      agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId,
      data: {
        subtype: 'http_response', flow_id: id, url: `https://${targetId}/${id}`, status: 200,
        response_body: { data: `${'x'.repeat(5000)} ${marker}`, encoding: 'text', size: 5010, sha256: 'producer-value' }
      }
    })
    return result.event!.id
  }

  it('finds a marker that exists only in an externalized response body', () => {
    const id = response('f1', 'BODYMARKER-9182')
    const page = searchPage({ query: 'BODYMARKER-9182', limit: 10 })
    expect(page.items.map((event) => event.id)).toEqual([id])
  })

  it('applies target filtering before the page limit and deduplicates metadata matches', () => {
    response('outside', 'needle', 'outside.test')
    const wanted = response('wanted', 'needle', 'wanted.test')
    const page = searchPage({ query: 'needle', targetId: 'wanted.test', limit: 1 })
    expect(page.items.map((event) => event.id)).toEqual([wanted])
  })

  it('removes evicted body content from search', () => {
    const id = response('gone', 'EVICTME-7711')
    const event = searchPage({ query: 'EVICTME-7711', limit: 10 }).items[0]
    expect(event.id).toBe(id)
    const ref = event.data.response_body_ref as { file: string; sha256: string }
    fs.unlinkSync(path.join(dir, 'http-bodies', ref.file))
    pruneHttpBodyIndex(ref.sha256, dir)
    expect(searchPage({ query: 'EVICTME-7711', limit: 10 }).items).toHaveLength(0)
  })

  it('backfills body references created before the derived index existed', () => {
    const text = `${'z'.repeat(5000)} LEGACYBODY-5512`
    const ref = storeBody({ data: text, encoding: 'text', size: text.length, sha256: 'ignored' })!
    const event = insertEvent('scanner', {
      subtype: 'http_response', flow_id: 'legacy', response_body_ref: ref
    }, { engagementId: 'eng', operatorId: 'op', targetId: 'legacy.test' })!

    expect(searchPage({ query: 'LEGACYBODY-5512', limit: 10 }).items.map((item) => item.id)).toEqual([event.id])
  })
})
