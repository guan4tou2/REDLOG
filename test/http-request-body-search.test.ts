// Is a word inside a JSON request body still found now that the addon no longer
// puts a parsed copy of it in `params.body_json`?
//
// Two indexes can answer. The events index (events_fts) tokenizes every key and
// value of the event's `data`; the body index (http-body-index.db) tokenizes the
// saved bytes of a body that went to the sidecar (more than 4096 characters).
// Search (Timeline, Activity) asks both.
//
// "before" is the payload the addon used to send: today's payload plus
// `params.body_json`, the JSON.parse of the body text, which is exactly what
// `json.loads` gave. "after" is what the real addon sends now.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { runAddonRequests } from './helpers/addon-request-payload'
import { parseQuery } from '../src/core/query/contract'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let getDB: typeof import('../src/core/db').getDB
let ingest: typeof import('../src/core/ingest').ingest
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let pruneHttpBodyIndex: typeof import('../src/core/http-body-index').pruneHttpBodyIndex
let searchHttpBodyEventIds: typeof import('../src/core/http-body-index').searchHttpBodyEventIds
let available = false
if (requires('better-sqlite3').ok) {
  const db = await import('../src/core/db')
  const ing = await import('../src/core/ingest')
  const idx = await import('../src/core/http-body-index')
  const queries = await import('../src/core/db/event-queries')
  initDB = db.initDB; closeDB = db.closeDB; getDB = db.getDB
  ingest = ing.ingest
  executeEventQuery = queries.executeEventQuery
  closeHttpBodyIndex = idx.closeHttpBodyIndex; pruneHttpBodyIndex = idx.pruneHttpBodyIndex
  searchHttpBodyEventIds = idx.searchHttpBodyEventIds
  available = true
}
const describeDB = available ? describe : describe.skip

// Non-ASCII as \uXXXX, the way an encoder that escapes it (Python's
// json.dumps default) writes it.
const asciiEscaped = (text: string): string => text.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

const SMALL = asciiEscaped(JSON.stringify({ smallkeyx: 'SMALLWORDX', escaped: '中文詞' }))
// HEAD* sit inside the first 4096 characters, TAIL* after them.
const LARGE = asciiEscaped(JSON.stringify({ headkeyx: 'HEADWORDX', pad: 'x'.repeat(6000), tailkeyx: 'TAILWORDX', tailescaped: '中文詞' }))

let dir: string
let ids: Record<'small' | 'large', { before: string; after: string }>

function surface(query: string): string[] {
  const outcome = parseQuery(query)
  if (!outcome.ok) throw new Error(outcome.reason)
  return executeEventQuery({ parsed: outcome.parsed, filter: {}, limit: 50 }).items.map(e => e.id)
}
/** Events whose own data the events index finds. */
function viaEvents(query: string): string[] {
  const match = `"${query}"`
  return (['events', 'events_logged'] as const).flatMap(table =>
    (getDB().prepare(`SELECT id FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}_fts WHERE ${table}_fts MATCH ?)`).all(match) as { id: string }[]).map(r => r.id))
}
const viaBody = (query: string): string[] => searchHttpBodyEventIds(query, dir)

/** [before, after] for one query: found, and through which index. */
function found(query: string, which: 'small' | 'large') {
  const at = (list: string[], key: 'before' | 'after') => list.includes(ids[which][key])
  return {
    before: { events: at(viaEvents(query), 'before'), body: at(viaBody(query), 'before'), surface: at(surface(query), 'before') },
    after: { events: at(viaEvents(query), 'after'), body: at(viaBody(query), 'after'), surface: at(surface(query), 'after') }
  }
}

describeDB('searching a JSON request body without params.body_json', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-reqbody-search-'))
    initDB(dir)
    const { results, python } = runAddonRequests([SMALL, LARGE].map(body => ({ contentType: 'application/json', body: Buffer.from(body) })))
    ids = {} as typeof ids
    ;(['small', 'large'] as const).forEach((which, i) => {
      const sent = results[i]
      if (!('data' in sent)) throw new Error(`addon (python ${python}): ${sent.error}`)
      const text = which === 'small' ? SMALL : LARGE
      const after = ingest({ agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId: 'api.test', data: { ...sent.data, flow_id: `${which}-after` } })
      const before = ingest({ agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId: 'api.test',
        data: { ...sent.data, flow_id: `${which}-before`, params: { ...(sent.data.params as object | undefined), body_json: JSON.parse(text) } } })
      ids[which] = { before: before.event!.id, after: after.event!.id }
    })
  })
  afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('the addon now sends the long body as a sidecar reference and the short one inline, with no params', () => {
    const row = (id: string) => (getDB().prepare('SELECT data FROM events_logged WHERE id=?').get(id) as { data: string })
    const large = JSON.parse(row(ids.large.after).data), small = JSON.parse(row(ids.small.after).data)
    expect(large.request_body).toBeUndefined()
    expect(large.request_body_ref.size).toBe(Buffer.byteLength(LARGE))
    expect(small.request_body.data).toBe(SMALL)
    expect(large.params).toBeUndefined()
    expect(JSON.parse(row(ids.large.before).data).params.body_json.headkeyx).toBe('HEADWORDX')
  })

  it('(a) a value in the first 4096 characters is found before and after, by the events index (preview) and the body index (sidecar)', () => {
    expect(found('HEADWORDX', 'large')).toEqual({
      before: { events: true, body: true, surface: true },
      after: { events: true, body: true, surface: true }
    })
  })

  it('(b) a value beyond 4096 characters: before by both indexes, after by the body index only', () => {
    expect(found('TAILWORDX', 'large')).toEqual({
      before: { events: true, body: true, surface: true },
      after: { events: false, body: true, surface: true }
    })
  })

  it('(c) a key name: in the first 4096 characters as for (a); beyond them as for (b)', () => {
    expect(found('headkeyx', 'large')).toEqual({
      before: { events: true, body: true, surface: true },
      after: { events: true, body: true, surface: true }
    })
    expect(found('tailkeyx', 'large')).toEqual({
      before: { events: true, body: true, surface: true },
      after: { events: false, body: true, surface: true }
    })
  })

  it('a short body (inline in the event, so not in the body index) is found by the events index before and after', () => {
    const both = { events: true, body: false, surface: true }
    expect(found('SMALLWORDX', 'small')).toEqual({ before: both, after: both })
    expect(found('smallkeyx', 'small')).toEqual({ before: both, after: both })
  })

  it('LOSS: text the encoder wrote as \\uXXXX escapes was found by its decoded form before and is not now', () => {
    const lost = { before: { events: true, body: false, surface: true }, after: { events: false, body: false, surface: false } }
    expect(found('中文詞', 'small')).toEqual(lost)
    // Long body: the escapes sit beyond the preview, and the body index tokenizes the saved bytes as written.
    expect(found('中文詞', 'large')).toEqual({ before: { events: true, body: false, surface: true }, after: { events: false, body: false, surface: false } })
    // The escape sequence itself is the only thing the saved bytes can be searched by.
    expect(found('u4e2d', 'large').after).toEqual({ events: false, body: true, surface: true })
  })

  it('LOSS: once retention removes the saved body, what is beyond the preview is no longer searchable', () => {
    const ref = JSON.parse((getDB().prepare('SELECT data FROM events_logged WHERE id=?').get(ids.large.after) as { data: string }).data).request_body_ref as { file: string; sha256: string }
    fs.unlinkSync(path.join(dir, 'http-bodies', ref.file))
    pruneHttpBodyIndex(ref.sha256, dir)
    expect(found('TAILWORDX', 'large')).toEqual({
      // `before` keeps finding it: the parsed copy outlived the file retention deleted.
      before: { events: true, body: false, surface: true },
      after: { events: false, body: false, surface: false }
    })
    // The preview is on the event itself and stays.
    expect(found('HEADWORDX', 'large').after.surface).toBe(true)
  })

  it('LOSS: a JSON body in a charset other than UTF-8 is saved as base64 bytes the body index cannot read', () => {
    const bytes = Buffer.from('{"city":"Zürichx"}', 'latin1')
    const { results, python } = runAddonRequests([{ contentType: 'application/json; charset=iso-8859-1', body: bytes }])
    const sent = results[0]
    if (!('data' in sent)) throw new Error(`addon (python ${python}): ${sent.error}`)
    expect((sent.data.request_body as { encoding: string }).encoding).toBe('base64')
    const post = (data: Record<string, unknown>) => ingest({ agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId: 'api.test', data }).event!.id
    const after = post({ ...sent.data, flow_id: 'latin-after' })
    const before = post({ ...sent.data, flow_id: 'latin-before', params: { body_json: { city: 'Zürichx' } } })
    expect(surface('Zürichx')).toEqual([before])
    expect(viaBody('Zürichx')).toEqual([])
    expect(surface('Zürichx')).not.toContain(after)
  })
})
