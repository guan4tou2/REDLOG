// Is a word inside a JSON body found now that the addon no longer puts a
// parsed copy of a request body in `params.body_json`?
//
// Two indexes can answer. The events index (events_fts) tokenizes every key and
// value of the event's `data`; the body index (http-body-index.db) tokenizes the
// saved bytes of a body that went to the sidecar (more than 4096 characters),
// plus, for request/response/WebSocket/TCP bodies, the same text with JSON
// `\uXXXX` escapes decoded, inline or not, and a body in a declared non-UTF-8
// charset decoded in that charset. Search (Timeline, Activity) asks both.
//
// "before" is the request payload the addon used to send: today's payload plus
// `params.body_json`, the JSON.parse of the body text, which is exactly what
// `json.loads` gave. "after" is what the real addon sends now. Responses never
// had a parsed copy; their events are written here in the shape the addon's
// response hook sends (`_capture_body`), since the fixture runs request hooks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { requires } from './helpers/requires'
import { runAddonRequests } from './helpers/addon-request-payload'
import { searchHttpBodyEventIds } from './helpers/body-search'
import { parseQuery } from '../src/core/query/contract'
import { decodeJsonEscapes } from '../src/core/json-escape-text'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let getDB: typeof import('../src/core/db').getDB
let ingest: typeof import('../src/core/ingest').ingest
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let countEvents: typeof import('../src/core/db/event-queries').countEvents
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let pruneHttpBodyIndex: typeof import('../src/core/http-body-index').pruneHttpBodyIndex
let bodySearchCoverage: typeof import('../src/core/http-body-index').bodySearchCoverage
let available = false
if (requires('better-sqlite3').ok) {
  const db = await import('../src/core/db')
  const ing = await import('../src/core/ingest')
  const idx = await import('../src/core/http-body-index')
  const queries = await import('../src/core/db/event-queries')
  initDB = db.initDB; closeDB = db.closeDB; getDB = db.getDB
  ingest = ing.ingest
  executeEventQuery = queries.executeEventQuery; countEvents = queries.countEvents
  closeHttpBodyIndex = idx.closeHttpBodyIndex; pruneHttpBodyIndex = idx.pruneHttpBodyIndex
  bodySearchCoverage = idx.bodySearchCoverage
  available = true
}
const describeDB = available ? describe : describe.skip

// Non-ASCII as \uXXXX (UTF-16 units, so an astral character is a surrogate
// pair), the way an encoder that escapes it (Python's json.dumps default)
// writes it.
const asciiEscaped = (text: string): string => text.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

const SMALL = asciiEscaped(JSON.stringify({ smallkeyx: 'SMALLWORDX', escaped: '中文詞', astral: '𠀋𠀌' }))
// HEAD* sit inside the first 4096 characters, TAIL* after them.
const LARGE = asciiEscaped(JSON.stringify({ headkeyx: 'HEADWORDX', pad: 'x'.repeat(6000), tailkeyx: 'TAILWORDX', tailescaped: '中文詞' }))
// Nothing to decode: stays out of the body index.
const PLAIN = JSON.stringify({ plainkeyx: 'PLAINWORDX' })

type Which = 'small' | 'large' | 'plain'
let dir: string
let ids: Record<Which, { before: string; after: string }>

const post = (data: Record<string, unknown>): string =>
  ingest({ agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId: 'api.test', data }).event!.id

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
const where = (query: string, id: string) => ({ events: viaEvents(query).includes(id), body: viaBody(query).includes(id), surface: surface(query).includes(id) })

/** [before, after] for one query: found, and through which index. */
function found(query: string, which: Which) {
  return { before: where(query, ids[which].before), after: where(query, ids[which].after) }
}

/** An http_response event as the addon's response hook sends it. */
function response(text: string | Buffer, contentType: string, flowId: string, url = 'http://10.0.0.5:8080/api/items'): string {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text)
  const asText = !Buffer.isBuffer(text)
  const body = {
    data: asText ? text : bytes.toString('base64'), encoding: asText ? 'text' : 'base64', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), truncated: false, content_type: contentType
  }
  const preview = asText ? (text.length > 4096 ? `${text.slice(0, 4096)}...[truncated, ${text.length} total]` : text) : ''
  return post({
    subtype: 'http_response', flow_id: flowId, method: 'POST', url, host: new URL(url).hostname, status: 200,
    content_length: bytes.length, content_type: contentType, response_headers: [['Content-Type', contentType]],
    ...(preview ? { response_preview: preview } : {}), response_body: body
  })
}
function request(contentType: string, body: Buffer, flowId: string, url?: string): string {
  const { results, python } = runAddonRequests([{ contentType, body, ...(url ? { url } : {}) }])
  const sent = results[0]
  if (!('data' in sent)) throw new Error(`addon (python ${python}): ${sent.error}`)
  return post({ ...sent.data, flow_id: flowId })
}

describeDB('searching a JSON body without params.body_json', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-reqbody-search-'))
    initDB(dir)
    const texts: Record<Which, string> = { small: SMALL, large: LARGE, plain: PLAIN }
    const order: Which[] = ['small', 'large', 'plain']
    const { results, python } = runAddonRequests(order.map(which => ({ contentType: 'application/json', body: Buffer.from(texts[which]) })))
    ids = {} as typeof ids
    order.forEach((which, i) => {
      const sent = results[i]
      if (!('data' in sent)) throw new Error(`addon (python ${python}): ${sent.error}`)
      const after = post({ ...sent.data, flow_id: `${which}-after` })
      const before = post({ ...sent.data, flow_id: `${which}-before`, params: { ...(sent.data.params as object | undefined), body_json: JSON.parse(texts[which]) } })
      ids[which] = { before, after }
    })
  })
  afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const row = (id: string) => JSON.parse((getDB().prepare('SELECT data FROM events_logged WHERE id=?').get(id) as { data: string }).data) as Record<string, unknown>

  it('the addon now sends the long body as a sidecar reference and the short one inline, with no params', () => {
    const large = row(ids.large.after), small = row(ids.small.after)
    expect(large.request_body).toBeUndefined()
    expect((large.request_body_ref as { size: number }).size).toBe(Buffer.byteLength(LARGE))
    expect((small.request_body as { data: string }).data).toBe(SMALL)
    expect(large.params).toBeUndefined()
    expect((row(ids.large.before).params as { body_json: { headkeyx: string } }).body_json.headkeyx).toBe('HEADWORDX')
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

  it('a short body with nothing to decode is found by the events index alone, before and after: it adds nothing to the body index', () => {
    // Right after ingest, before any search walks the rows.
    expect(getIndexRows().filter(r => r.event_id === ids.plain.after || r.event_id === ids.plain.before)).toEqual([])
    // A body with a backslash-u that is not an escape is walked (the partial
    // index admits any backslash-u) and still gets no entry.
    const literal = response(JSON.stringify({ path: 'C:\\users\\u4e2dx' }), 'application/json', 'literal-backslash')
    expect(JSON.parse((getDB().prepare('SELECT data FROM events_logged WHERE id=?').get(literal) as { data: string }).data).response_body.data).toContain('\\\\u4e2dx')
    surface('u4e2dx')
    expect(getIndexRows().filter(r => r.event_id === literal)).toEqual([])
    const both = { events: true, body: false, surface: true }
    expect(found('PLAINWORDX', 'plain')).toEqual({ before: both, after: both })
    expect(found('plainkeyx', 'plain')).toEqual({ before: both, after: both })
    const refs = getIndexRows().filter(r => r.event_id === ids.plain.after || r.event_id === ids.plain.before)
    expect(refs).toEqual([])
  })

  it('FOUND: request text written as \\uXXXX escapes is found by the decoded word, inline and in the sidecar, through the body index', () => {
    const decoded = { before: { events: true, body: true, surface: true }, after: { events: false, body: true, surface: true } }
    expect(found('中文詞', 'small')).toEqual(decoded)
    expect(found('中文詞', 'large')).toEqual(decoded)
    // An astral character is written as a surrogate pair of escapes.
    expect(found('𠀋𠀌', 'small')).toEqual(decoded)
    // The saved bytes are still found as written.
    expect(found('u4e2d', 'large').after).toEqual({ events: false, body: true, surface: true })
    expect(found('u4e2d', 'small').after).toEqual({ events: true, body: false, surface: true })
    // AND across a decoded word and a plain one stays within one body.
    expect(surface('中文詞 SMALLWORDX')).toContain(ids.small.after)
    expect(surface('中文詞 TAILWORDX')).not.toContain(ids.small.after)
  })

  it('index size: a saved body with escapes is indexed twice (as saved and decoded), one without escapes once', () => {
    const plainLarge = response(JSON.stringify({ pad: 'q'.repeat(6000), w: 'PLAINLARGEX' }), 'application/json', 'resp-plain-large')
    viaBody('PLAINLARGEX')
    const db = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    const chars = (id: string): number => (db.prepare('SELECT coalesce(sum(length(f.content)),0) AS n FROM body_fts f JOIN body_docs d ON d.doc=f.rowid WHERE d.event_id=?').get(id) as { n: number }).n
    const escaped = chars(ids.large.after), plain = chars(plainLarge), inline = chars(ids.small.after)
    db.close()
    console.log(`[index size] escaped sidecar ${LARGE.length} chars -> ${escaped}; plain sidecar ${JSON.stringify({ pad: 'q'.repeat(6000), w: 'PLAINLARGEX' }).length} -> ${plain}; escaped inline ${SMALL.length} -> ${inline}`)
    expect(plain).toBe(JSON.stringify({ pad: 'q'.repeat(6000), w: 'PLAINLARGEX' }).length)
    expect(escaped).toBe(LARGE.length + (decodeJsonEscapes(LARGE) ?? '').length)
    // SQLite's length() counts characters; the astral pair is one each.
    expect(inline).toBe([...(decodeJsonEscapes(SMALL) ?? '')].length)
  })

  it('IMPROVEMENT: response text written as \\uXXXX escapes, never found by the decoded word before (no parsed copy existed), is found now, inline and in the sidecar', () => {
    const small = response(asciiEscaped(JSON.stringify({ msg: '回應詞彙' })), 'application/json; charset=utf-8', 'resp-small')
    const large = response(asciiEscaped(JSON.stringify({ pad: 'y'.repeat(6000), msg: '回應詞彙' })), 'application/json', 'resp-large')
    expect(where('回應詞彙', small)).toEqual({ events: false, body: true, surface: true })
    expect(where('回應詞彙', large)).toEqual({ events: false, body: true, surface: true })
  })

  it('decodes escapes in any text body, not by content type: an HTML page with an inline script, and documentation that writes an escape literally', () => {
    const page = response(`<script>window.STATE={"t":"${asciiEscaped('網頁標題')}"}</script>`, 'text/html', 'resp-html')
    expect(where('網頁標題', page).surface).toBe(true)
    // The accepted false match: text that shows an escape literally matches
    // the letter it stands for.
    // The letters AQZX never appear as such in this body.
    const literal = response('JSON writes the letter as \\u0041QZX in this example.', 'text/plain', 'resp-literal')
    expect(where('AQZX', literal)).toEqual({ events: false, body: true, surface: true })
  })

  it('coverage counts the decoded entry of an inline body, and decoded text follows the event when it is deleted', () => {
    surface('中文詞')
    const body = bodySearchCoverage().sources!.find(s => s.kind === 'body')!
    expect(body.status).toBe('covered')
    expect(getIndexRows().filter(r => r.event_id === ids.small.after)).toEqual([expect.objectContaining({ status: 'indexed', file: 'inline:request_body' })])
    getDB().prepare('DELETE FROM events_logged WHERE id=?').run(ids.small.after)
    expect(surface('中文詞')).not.toContain(ids.small.after)
    expect(getIndexRows().filter(r => r.event_id === ids.small.after)).toEqual([])
  })

  it('an export snapshot finds decoded text only for events inside its boundary', () => {
    const boundary = (getDB().prepare('SELECT max(rowid) AS n FROM events_logged').get() as { n: number }).n
    const later = response(asciiEscaped(JSON.stringify({ k: '後來詞' })), 'application/json', 'resp-later')
    const chained = (getDB().prepare('SELECT coalesce(max(rowid),0) AS n FROM events').get() as { n: number }).n
    const snapshot = { chainedMaxRowId: chained, loggedMaxRowId: boundary, takenAt: 0 }
    expect(searchHttpBodyEventIds('後來詞', dir, false, snapshot)).toEqual([])
    expect(searchHttpBodyEventIds('中文詞', dir, false, snapshot)).toEqual(expect.arrayContaining([ids.small.after, ids.large.after]))
    expect(searchHttpBodyEventIds('後來詞', dir)).toEqual([later])
  })

  it('a deleted body index is rebuilt with the decoded text; an index from before decoding (v7) is replaced', () => {
    expect(surface('中文詞')).toContain(ids.large.after)
    closeHttpBodyIndex()
    fs.rmSync(path.join(dir, 'http-body-index.db'), { force: true })
    for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(dir, `http-body-index.db${suffix}`), { force: true })
    expect(surface('中文詞')).toEqual(expect.arrayContaining([ids.small.after, ids.large.after]))
    closeHttpBodyIndex()
    const old = new Database(path.join(dir, 'http-body-index.db'))
    old.exec('DELETE FROM body_fts; DELETE FROM body_docs; DELETE FROM body_event_refs;')
    old.pragma('user_version=7')
    old.close()
    expect(surface('中文詞')).toEqual(expect.arrayContaining([ids.small.after, ids.large.after]))
  })

  it('a project whose content-ref index was built from the older predicate gets it rebuilt at open, and finds inline escaped bodies', () => {
    const db = getDB()
    for (const table of ['events', 'events_logged']) {
      db.exec(`DROP INDEX idx_${table}_content_refs`)
      db.exec(`CREATE INDEX idx_${table}_content_refs ON ${table}(id) WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.request_body_ref.sha256') IS NOT NULL ELSE 0 END`)
    }
    closeHttpBodyIndex(); closeDB()
    initDB(dir)
    const sql = (getDB().prepare("SELECT sql FROM sqlite_master WHERE name='idx_events_logged_content_refs'").get() as { sql: string }).sql
    expect(sql).toContain("instr(json_extract(data,'$.request_body.data'),'\\u')>0")
    expect(surface('中文詞')).toContain(ids.small.after)
  })

  it('KNOWN, BY DESIGN: once retention removes the saved body, what is beyond the preview is no longer searchable, decoded or not', () => {
    const ref = row(ids.large.after).request_body_ref as { file: string; sha256: string }
    fs.unlinkSync(path.join(dir, 'http-bodies', ref.file))
    pruneHttpBodyIndex(ref.sha256, dir)
    // At once, before any walk: no document of that body is left to match.
    const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try {
      expect(index.prepare('SELECT count(*) AS n FROM body_docs WHERE sha256=?').get(ref.sha256)).toEqual({ n: 0 })
      expect(index.prepare("SELECT count(*) AS n FROM body_fts WHERE body_fts MATCH 'TAILWORDX'").get()).toEqual({ n: 0 })
    } finally { index.close() }
    expect(found('TAILWORDX', 'large')).toEqual({
      // `before` keeps finding it: the parsed copy outlived the file retention deleted.
      before: { events: true, body: false, surface: true },
      after: { events: false, body: false, surface: false }
    })
    expect(found('中文詞', 'large').after).toEqual({ events: false, body: false, surface: false })
    // The preview is on the event itself and stays.
    expect(found('HEADWORDX', 'large').after.surface).toBe(true)
    // And search says the body is gone rather than that it was searched.
    expect(bodySearchCoverage().sources!.find(s => s.kind === 'body')).toEqual(expect.objectContaining({ status: 'unavailable', missing: 2 }))
  })

  it('KNOWN: words past the capture cap (REDLOG_MAX_BODY, 10 MiB by default) are not saved, so neither index has them; the parsed copy used to hold the whole body', () => {
    const text = JSON.stringify({ pad: 'z'.repeat(9000), capword: 'CAPWORDX' })
    const { results, python } = runAddonRequests([{ contentType: 'application/json', body: Buffer.from(text) }], { env: { REDLOG_MAX_BODY: '8192' } })
    const sent = results[0]
    if (!('data' in sent)) throw new Error(`addon (python ${python}): ${sent.error}`)
    const after = post({ ...sent.data, flow_id: 'cap-after' })
    const before = post({ ...sent.data, flow_id: 'cap-before', params: { body_json: JSON.parse(text) } })
    expect(row(after).request_body_ref).toEqual(expect.objectContaining({ size: 8192, truncated: true, totalSize: Buffer.byteLength(text) }))
    expect(surface('CAPWORDX')).toEqual([before])
    // And search says so: the body is indexed only in part, and its source
    // size is what the capture saw, not what was saved.
    const capped = getIndexRows().filter(r => r.event_id === after || r.event_id === before)
    expect(capped.map(r => r.status)).toEqual(['partial', 'partial'])
    const body = bodySearchCoverage().sources!.find(s => s.kind === 'body')!
    expect(body).toEqual(expect.objectContaining({ status: 'partial', partial: 2 }))
    expect(body.sourceBytes - body.indexedBytes).toBeGreaterThanOrEqual(2 * (Buffer.byteLength(text) - 8192))
  })

  it('a response cut at the capture cap is counted partial too', () => {
    const text = JSON.stringify({ pad: 'r'.repeat(6000), w: 'CUTRESPX' })
    const id = post({ subtype: 'http_response', flow_id: 'cut-response', url: 'http://10.0.0.5/x', status: 200, content_type: 'application/json',
      response_body: { data: text, encoding: 'text', size: 50_000, sha256: '', truncated: true, content_type: 'application/json' } })
    expect(surface('CUTRESPX')).toContain(id)
    expect(row(id).response_body_ref).toEqual(expect.objectContaining({ truncated: true, totalSize: 50_000 }))
    expect(getIndexRows().filter(r => r.event_id === id).map(r => r.status)).toEqual(['partial'])
    expect(bodySearchCoverage().sources!.find(s => s.kind === 'body')).toEqual(expect.objectContaining({ partial: 1, status: 'partial' }))
  })

  describe('a JSON body in a declared charset other than UTF-8 (saved as base64)', () => {
    const latin = (word: string, pad = 0): Buffer => Buffer.from(JSON.stringify({ pad: 'p'.repeat(pad), city: word }), 'latin1')
    const big5 = (pad = 0): Buffer => Buffer.concat([Buffer.from(`{"pad":"${'p'.repeat(pad)}","w":"`), Buffer.from('a4a4a4e5b5fc', 'hex'), Buffer.from('"}')])

    it('FOUND: a request in iso-8859-1, inline and in the sidecar', () => {
      const inline = request('application/json; charset=iso-8859-1', latin('Zürichx'), 'latin-inline')
      const sidecar = request('application/json; charset=ISO-8859-1', latin('Zürichy', 5000), 'latin-sidecar')
      expect((row(inline).request_body as { encoding: string }).encoding).toBe('base64')
      expect(row(sidecar).request_body_ref).toEqual(expect.objectContaining({ encoding: 'base64' }))
      expect(where('Zürichx', inline)).toEqual({ events: false, body: true, surface: true })
      expect(where('Zürichy', sidecar)).toEqual({ events: false, body: true, surface: true })
    })

    it('FOUND: a request and a response in big5, inline and in the sidecar', () => {
      const req = request('application/json; charset=big5', big5(), 'big5-request')
      const reqLarge = request('application/json; charset="Big5"', big5(5000), 'big5-request-large')
      const res = response(big5(), 'application/json; charset=big5', 'big5-response')
      const resLarge = response(big5(5000), 'application/json;charset=big5', 'big5-response-large')
      expect(viaBody('中文詞')).toEqual(expect.arrayContaining([req, reqLarge, res, resLarge]))
      expect(getIndexRows().filter(r => [req, reqLarge, res, resLarge].includes(r.event_id)).map(r => r.status)).toEqual(['indexed', 'indexed', 'indexed', 'indexed'])
    })

    it('FOUND: a response in iso-8859-1 whose text also carries escapes is found by both', () => {
      const res = response(Buffer.from(`{"a":"Genèvex","b":"${asciiEscaped('日本語x')}"}`, 'latin1'), 'application/json; charset=iso-8859-1', 'latin-response')
      expect(viaBody('Genèvex')).toEqual([res])
      expect(viaBody('日本語x')).toEqual([res])
    })

    // Electron's runtime (Node 24.22 / ICU 78) fails on invalid Big5; Node
    // 24.12 (ICU 77) drops the bytes with no error and no U+FFFD, so there a
    // corrupt Big5 body is indexed with those bytes missing and counted indexed.
    // The test name says which this runtime is; the shipped runtime is pinned
    // by test/electron-big5.test.ts.
    const big5Signals = ((): boolean => { try { new TextDecoder('big5', { fatal: true }).decode(Buffer.from('80ff41', 'hex')); return false } catch { return true } })()
    const runtime = `node ${process.versions.node}, icu ${process.versions.icu}`
    console.log(`[big5] ${runtime}: invalid Big5 ${big5Signals ? 'rejected' : 'dropped silently'}`)
    it(big5Signals
      ? `leaves a body declared big5 whose bytes are not valid Big5 binary (${runtime} rejects invalid Big5)`
      : `KNOWN (${runtime}): a body declared big5 with invalid bytes is indexed with those bytes missing — the decoder gives no signal`, () => {
      const bad = response(Buffer.concat([big5(), Buffer.from(' QZBADX '), Buffer.from('80ff', 'hex')]), 'application/json; charset=big5', 'big5-invalid')
      const body = () => bodySearchCoverage().sources!.find(s => s.kind === 'body')!
      viaBody('QZBADX')
      if (big5Signals) {
        expect(viaBody('QZBADX')).toEqual([])
        expect(body()).toEqual(expect.objectContaining({ binary: 1 }))
      } else {
        expect(viaBody('QZBADX')).toEqual([bad])
        expect(body()).toEqual(expect.objectContaining({ binary: 0 }))
      }
    })

    it('decodes by a declared charset only for a textual media type', () => {
      // A PNG-like body declared UTF-16 or windows-1252 stays binary.
      const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('PNGWORDQ'), Buffer.from('fe', 'hex')])
      const asImage = response(png, 'image/png; charset=utf-16le', 'png-utf16')
      const asBytes = response(png, 'application/octet-stream; charset=windows-1252', 'png-1252')
      // The same declaration on a textual type is read in it.
      const utf16 = response(Buffer.from('{"w":"UTF16WORDQ"}', 'utf16le'), 'text/plain; charset=utf-16le', 'text-utf16')
      expect(viaBody('UTF16WORDQ')).toEqual([utf16])
      expect(viaBody('PNGWORDQ')).toEqual([])
      expect(getIndexRows().filter(r => r.event_id === asImage || r.event_id === asBytes).map(r => r.status)).toEqual(['binary', 'binary'])
    })

    it('a body that ends mid-character is indexed up to the cut and counted partial, in its charset or in UTF-8', () => {
      const cutBig5 = response(Buffer.concat([big5(), Buffer.from(' TAILBIG5Q '), Buffer.from('a4', 'hex')]), 'application/json; charset=big5', 'cut-big5')
      const cutUtf8 = response(Buffer.concat([Buffer.from('{"w":"CUTUTF8Q 中'), Buffer.from('e6', 'hex')]), 'application/json', 'cut-utf8')
      expect(viaBody('TAILBIG5Q')).toEqual([cutBig5])
      expect(viaBody('中文詞')).toContain(cutBig5)
      expect(viaBody('CUTUTF8Q')).toEqual([cutUtf8])
      expect(getIndexRows().filter(r => r.event_id === cutBig5 || r.event_id === cutUtf8).map(r => r.status)).toEqual(['partial', 'partial'])
      expect(bodySearchCoverage().sources!.find(s => s.kind === 'body')).toEqual(expect.objectContaining({ partial: 2, status: 'partial' }))
    })

    it('leaves alone a body with no declared charset, or one whose bytes hold a NUL, and says so in coverage', () => {
      const undeclared = response(latin('Zürichz'), 'application/json', 'latin-undeclared')
      const nul = response(Buffer.concat([latin('Zürichw'), Buffer.from([0])]), 'application/json; charset=iso-8859-1', 'latin-nul')
      expect(viaBody('Zürichz')).not.toContain(undeclared)
      expect(viaBody('Zürichw')).not.toContain(nul)
      const body = bodySearchCoverage().sources!.find(s => s.kind === 'body')!
      expect(body).toEqual(expect.objectContaining({ binary: 2, status: 'partial' }))
    })
  })
})

function getIndexRows(): Array<{ event_id: string; status: string; file: string }> {
  const db = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
  try { return db.prepare('SELECT event_id,status,file FROM body_event_refs').all() as Array<{ event_id: string; status: string; file: string }> }
  finally { db.close() }
}

describeDB('a query of several words matches an event when each word is somewhere in it', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-multiterm-')); initDB(dir) })
  afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  // Each body holds BODYWORD as stated; URLWORD is in its URL path, HOSTWORD
  // its host, HDRWORD a header value. Before, the body words of the escaped
  // and the past-the-preview bodies were only in the body index, so a query
  // pairing one with an event word found nothing (for requests it used to,
  // through params.body_json).
  const bodies: Array<[string, (word: string) => string]> = [
    ['inline, escaped', w => asciiEscaped(JSON.stringify({ w: `${w}詞` }))],
    ['inline, plain', w => JSON.stringify({ w })],
    ['saved, escaped, past the preview', w => asciiEscaped(JSON.stringify({ pad: 'p'.repeat(6000), w: `${w}詞` }))],
    ['saved, plain, past the preview', w => JSON.stringify({ pad: 'p'.repeat(6000), w })]
  ]
  const wordOf = (kind: string, n: number) => `${kind.replace(/[^a-z]/g, '').slice(0, 6)}w${n}`
  for (const side of ['request', 'response'] as const) {
    bodies.forEach(([label, make], n) => {
      it(`${side}, ${label}: body word + URL word, + host word, + header value`, () => {
        const body = wordOf(side, n), word = make(body)
        const query = (w: string) => surface(w)
        const url = `http://host${side}${n}.test/path${side}${n}x/items`
        const header = `application/json; profile=hdr${side}${n}x`
        const id = side === 'request' ? request(header, Buffer.from(word), `mt-${side}-${n}`, url) : response(word, header, `mt-${side}-${n}`, url)
        const bodyTerm = label.includes('escaped') ? `${body}詞` : body
        expect(query(bodyTerm)).toContain(id)
        expect(query(`${bodyTerm} path${side}${n}x`)).toContain(id)
        expect(query(`${bodyTerm} host${side}${n}`)).toContain(id)
        expect(query(`hdr${side}${n}x ${bodyTerm}`)).toContain(id)
        expect(query(`${bodyTerm} nowhereq${n}`)).toEqual([])
      })
    })
  }

  it('two words in one body, and a word missing everywhere', () => {
    const id = response(asciiEscaped(JSON.stringify({ a: '第一詞', b: '第二詞' })), 'application/json', 'two-words')
    expect(surface('第一詞 第二詞')).toEqual([id])
    expect(surface('第一詞 不存在詞')).toEqual([])
  })

  it('pages and counts a multi-word query the same way', () => {
    const ids = Array.from({ length: 7 }, (_, i) => response(asciiEscaped(JSON.stringify({ w: '分頁詞' })), 'application/json', `page-${i}`, `http://pages.test/pagewordq/${i}`))
    response(asciiEscaped(JSON.stringify({ w: '分頁詞' })), 'application/json', 'page-other', 'http://pages.test/elsewhere')
    const outcome = parseQuery('分頁詞 pagewordq')
    if (!outcome.ok) throw new Error(outcome.reason)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = executeEventQuery({ parsed: outcome.parsed, filter: {}, limit: 3, cursor })
      seen.push(...page.items.map(e => e.id))
      cursor = page.hasMore ? page.nextCursor : null
    } while (cursor)
    expect(seen.sort()).toEqual([...ids].sort())
    expect(countEvents({ parsed: outcome.parsed, filter: {} })).toBe(7)
  })
})
