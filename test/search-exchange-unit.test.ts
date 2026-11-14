// Decision 2026-11-15 §1 item 5: a multi-word search matches across one HTTP
// exchange. The Activity page shows a request and its response as one row, so
// a word in the request body and a word in the response body searched together
// must find it; before this change each Event had to hold every word itself.
//
// The unit is the exchange as the Activity projection groups it (activityKey's
// `http` arm: project, capture session, `data.source`, `flow_id`, over the
// HTTP subtypes it lists). An Event of an exchange matches when every term is
// found somewhere in the exchange's rows or their bodies AND the Event itself
// holds at least one term; the other rows of the exchange are context. Every
// other Event is its own unit, as before.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parsed } from './helpers/body-index-work'
import type { ExportSnapshot } from '../src/core/export-plan'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db/index')
let queries: typeof import('../src/core/db/event-queries')
let activity: typeof import('../src/core/db/activity-queries')
let idx: typeof import('../src/core/http-body-index')
let store: typeof import('../src/core/http-body-store')
let projection: typeof import('../src/core/activity-projection')
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
let classifyTier: typeof import('../src/core/db/event-write').classifyTier
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  queries = await import('../src/core/db/event-queries')
  activity = await import('../src/core/db/activity-queries')
  idx = await import('../src/core/http-body-index')
  store = await import('../src/core/http-body-store')
  projection = await import('../src/core/activity-projection')
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
  classifyTier = (await import('../src/core/db/event-write')).classifyTier
}

let dir = ''
let ts = 1000
interface Row { id: string; type?: string; data: Record<string, unknown>; session?: string; project?: string; tier?: 'chained' | 'logged' }
function add(...rows: Row[]): void {
  const write = db.getDB().transaction(() => {
    for (const r of rows) {
      const tier = r.tier ?? 'logged', table = tier === 'logged' ? 'events_logged' : 'events', t = ts++
      db.getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${tier === 'chained' ? ',hash,prev_hash' : ''})
        VALUES (?,?,?,?,?,?,?,'host',NULL,NULL,?,?${tier === 'chained' ? ", 'fixture-hash', NULL" : ''})`).run(
        r.id, t, r.project ?? 'eng', r.session ?? 'cap1', 'operator', r.type ?? 'scanner', String(r.data.subtype ?? ''), JSON.stringify(r.data), t)
    }
  })
  write()
}
const saved = (text: string): ReturnType<typeof store.storeBody> => store.storeBody({ data: text, encoding: 'text', size: Buffer.byteLength(text), sha256: '' })
const req = (id: string, flow: string, more: Record<string, unknown> = {}): Row => ({ id, data: { subtype: 'http_request_start', flow_id: flow, method: 'POST', host: 'h.test', url: 'https://h.test/api', ...more } })
const res = (id: string, flow: string, more: Record<string, unknown> = {}): Row => ({ id, data: { subtype: 'http_response', flow_id: flow, host: 'h.test', status: 200, ...more } })

const found = (text: string, snapshot?: ExportSnapshot): string[] => {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 1, ...(snapshot ? { snapshot } : {}), cursor })
    ids.push(...page.items.map(e => e.id))
    cursor = page.hasMore ? page.nextCursor : null
  } while (cursor)
  return ids.sort()
}
const counted = (text: string): number => queries.countEvents({ parsed: parsed(text), filter: {} })
const matched = (text: string, ids: string[]): string[] => queries.matchEventIds({ parsed: parsed(text), filter: {}, ids }).sort()
/** The three readers agree, and give `expected`. */
function agree(text: string, expected: string[], all: string[]): void {
  expect(found(text), `pages of "${text}"`).toEqual([...expected].sort())
  expect(counted(text), `count of "${text}"`).toBe(expected.length)
  expect(matched(text, all), `match of "${text}"`).toEqual([...expected].sort())
  for (const id of all) expect(matched(text, [id]), `match of "${text}" on ${id} alone`).toEqual(expected.includes(id) ? [id] : [])
}

sqlite.describe('a multi-word search matches across one HTTP exchange', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-exchange-')); db.initDB(dir); store.resetBodiesDirCache(); ts = 1000 })
  afterEach(() => { idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('finds a word in the request body and a word in the response body together (the observed case)', () => {
    add(req('rq', 'f1', { request_body_ref: saved('{"report":"quarterly figures"}') }),
      res('rs', 'f1', { response_body_ref: saved('{"role":"administrator"}') }))
    const all = ['rq', 'rs']
    agree('quarterly', ['rq'], all)
    agree('administrator', ['rs'], all)
    agree('quarterly administrator', ['rq', 'rs'], all)
    agree('administrator quarterly', ['rq', 'rs'], all)
  })

  it('finds a URL word on the request with a word in the response body', () => {
    add(req('rq', 'f1', { url: 'https://h.test/zebrapath' }), res('rs', 'f1', { response_body_ref: saved('welcome administrator') }))
    agree('zebrapath administrator', ['rq', 'rs'], ['rq', 'rs'])
  })

  it('finds three terms in three places, and an inline body counts as a place', () => {
    add(req('rq', 'f1', { url: 'https://h.test/alphaword', request_body: { data: 'betaword=1', encoding: 'text', size: 10 } }),
      res('rs', 'f1', { response_body_ref: saved('gammaword') }),
      { id: 'other', data: { subtype: 'http_response', flow_id: 'f2', url: 'https://h.test/alphaword' } })
    agree('alphaword betaword gammaword', ['rq', 'rs'], ['rq', 'rs', 'other'])
  })

  it('does not match when one term is in neither row', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }), res('rs', 'f1', { response_body_ref: saved('administrator') }))
    agree('quarterly administrator nowhereword', [], ['rq', 'rs'])
  })

  it('does not join two flows of one host: the unit is the exchange', () => {
    add(req('a1', 'fa', { request_body_ref: saved('quarterly') }), res('a2', 'fa'),
      req('b1', 'fb'), res('b2', 'fb', { response_body_ref: saved('administrator') }))
    agree('quarterly administrator', [], ['a1', 'a2', 'b1', 'b2'])
  })

  it('does not join one flow_id across two capture sessions, or two sources, or two projects', () => {
    add(req('s1', 'f1', { request_body_ref: saved('quarterly') }),
      { ...res('s2', 'f1', { response_body_ref: saved('administrator') }), session: 'cap2' },
      { ...res('s3', 'f1', { response_body_ref: saved('administrator'), source: 'other-proxy' }) },
      { ...res('s4', 'f1', { response_body_ref: saved('administrator') }), project: 'eng2' })
    agree('quarterly administrator', [], ['s1', 's2', 's3', 's4'])
  })

  it('keeps every other Event its own unit: two shell rows do not combine', () => {
    add({ id: 'c1', type: 'shell', tier: 'chained', data: { subtype: 'command_start', command_id: 'x', command: 'quarterly' } },
      { id: 'c2', type: 'shell', tier: 'chained', data: { subtype: 'command_end', command_id: 'x', command: 'other', stdout: 'administrator' } })
    agree('quarterly administrator', [], ['c1', 'c2'])
  })

  // Not decided (2026-11-15): this pins what a command's rows answer today, so
  // a decision to join them changes this test on purpose.
  it('a command: its end row holds the command and the output, but a streamed chunk holds only output', () => {
    const shell = (id: string, data: Record<string, unknown>): Row => ({ id, type: 'shell', tier: 'chained', data: { terminalId: 't1', ...data } })
    add(shell('id-start', { subtype: 'command_start', command_id: 'k1', command: 'id', cwd: '/root' }),
      shell('id-end', { subtype: 'command_end', command_id: 'k1', command: 'id', exit_code: 0, stdout: 'uid=0(root) gid=0(root)' }),
      shell('nm-start', { subtype: 'command_start', command_id: 'k2', command: 'nmap -p- 10.0.0.5', cwd: '/root' }),
      shell('nm-end', { subtype: 'command_end', command_id: 'k2', command: 'nmap -p- 10.0.0.5', exit_code: 0, output_streamed: true, completeness: 'partial' }),
      shell('nm-chunk', { subtype: 'command_output', command_id: 'k2', streamed: true, late: false, seq: 0, stdout: '22/tcp open ssh' }))
    const all = ['id-start', 'id-end', 'nm-start', 'nm-end', 'nm-chunk']
    agree('id uid=0', ['id-end'], all)
    agree('nmap 22/tcp', [], all)
  })

  it('does not group TCP messages, which the Activity page shows one by one', () => {
    add({ id: 't1', data: { subtype: 'tcp_message', flow_id: 'ft', content: 'quarterly' } },
      { id: 't2', data: { subtype: 'tcp_message', flow_id: 'ft', content: 'administrator' } })
    agree('quarterly administrator', [], ['t1', 't2'])
  })

  it('a WebSocket flow of many messages: the messages holding a term match, the rest are context', () => {
    const rows: Row[] = [req('up', 'ws1', { url: 'wss://h.test/socket' })]
    for (let i = 0; i < 40; i++) rows.push({ id: `m${String(i).padStart(2, '0')}`, data: { subtype: 'ws_message', flow_id: 'ws1', content: i === 3 ? 'quarterly' : i === 31 ? 'administrator' : `chatter ${i}` } })
    rows.push({ id: 'end', data: { subtype: 'websocket_end', flow_id: 'ws1' } })
    add(...rows)
    const all = rows.map(r => r.id)
    agree('quarterly administrator', ['m03', 'm31'], all)
    agree('socket administrator', ['up', 'm31'], all)
    const page = activity.queryActivityPage({ projectId: 'eng', parsed: parsed('quarterly administrator'), limit: 10 })
    expect(page.items.map(a => [a.kind, a.matchedCount, a.contextCount, a.sourceCount])).toEqual([['http', 2, 40, 42]])
    expect(page.totalMatches).toBe(2)
  })

  it('a streamed response chunk and an error row are rows of the exchange', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }),
      { id: 'ch', data: { subtype: 'http_response_chunk', flow_id: 'f1', content: 'administrator' } },
      { id: 'er', data: { subtype: 'http_error', flow_id: 'f1', error: 'reset by peer' } })
    agree('quarterly administrator', ['rq', 'ch'], ['rq', 'ch', 'er'])
    agree('quarterly reset', ['rq', 'er'], ['rq', 'ch', 'er'])
  })

  it('shows the exchange once on the Activity page, with the rows holding a term as hits', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }),
      res('rs', 'f1', { response_body_ref: saved('administrator') }),
      { id: 'ch', data: { subtype: 'http_response_chunk', flow_id: 'f1', content: 'neither' } })
    const page = activity.queryActivityPage({ projectId: 'eng', parsed: parsed('quarterly administrator'), limit: 10 })
    expect(page.items.map(a => [a.kind, a.matchedCount, a.contextCount])).toEqual([['http', 2, 1]])
    expect(page.items[0].matchedPreview.ids.sort()).toEqual(['rq', 'rs'])
    const members = activity.queryActivityMembers({ projectId: 'eng', parsed: parsed('quarterly administrator'), ref: page.items[0], snapshot: page.snapshot, limit: 10 })
    expect(Object.fromEntries(members.items.map(m => [m.event.id, m.matched]))).toEqual({ rq: true, rs: true, ch: false })
  })

  it('under a snapshot, a row past it neither joins the exchange nor lends it a term', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }))
    const before = readActivitySnapshot(db.getReadonlyDB())
    // In its own data (the events index) as well as its body (the body index,
    // which bounds its own answer by the snapshot).
    add(res('rs', 'f1', { server: 'administrator', response_body_ref: saved('administrator quarterly') }))
    const after = readActivitySnapshot(db.getReadonlyDB())
    expect(found('quarterly administrator', before)).toEqual([])
    expect(found('quarterly', before)).toEqual(['rq'])
    expect(found('quarterly administrator', after)).toEqual(['rq', 'rs'])
    // The export selection reads through the same query under its snapshot.
    expect(queries.executeEventQuery({ parsed: parsed('quarterly administrator'), filter: {}, snapshot: before, limit: 10 }).items).toEqual([])
  })

  it('a time range decides which rows are answered, not where a term may be found', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }), res('rs', 'f1', { response_body_ref: saved('administrator') }))
    const first = queries.executeEventQuery({ parsed: parsed('quarterly administrator'), filter: { since: 1000, before: 1000 }, limit: 10 })
    expect(first.items.map(e => e.id)).toEqual(['rq'])
    expect(queries.countEvents({ parsed: parsed('quarterly administrator'), filter: { since: 1000, before: 1000 } })).toBe(1)
  })

  it('a cursor taken before the response arrived keeps paging the dataset it was taken in', () => {
    add(req('rq', 'f1', { request_body_ref: saved('quarterly') }), res('rs', 'f1', { response_body_ref: saved('administrator') }),
      req('rq2', 'f2', { request_body_ref: saved('quarterly') }))
    const first = queries.executeEventQuery({ parsed: parsed('quarterly administrator'), filter: {}, limit: 1 })
    expect(first.items.map(e => e.id)).toEqual(['rs'])
    add(res('rs2', 'f2', { response_body_ref: saved('administrator') }))
    const next = queries.executeEventQuery({ parsed: parsed('quarterly administrator'), filter: {}, limit: 1, cursor: first.nextCursor })
    expect(next.items.map(e => e.id)).toEqual(['rq'])
    expect(next.hasMore).toBe(false)
    expect(queries.countEvents({ parsed: parsed('quarterly administrator'), filter: {}, cursor: first.nextCursor })).toBe(1)
  })

  it('every subtype of the unit is written to the logged tier, which is the only arm that joins rows', () => {
    for (const subtype of projection.HTTP) expect(classifyTier('scanner', { subtype }), subtype).toBe('logged')
  })
})

sqlite.describe('the exchange key is the Activity grouping key', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-exchange-key-')); db.initDB(dir); ts = 1000 })
  afterEach(() => { idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('two logged rows share an exchange key exactly when activityKey puts them in one http Activity', () => {
    const subtypes = [...projection.HTTP, 'tcp_message', 'tcp_end', 'http_request_dropped', 'dns_query', '']
    const rows: Row[] = []
    let n = 0
    for (const type of ['scanner', 'dns'])
      for (const subtype of subtypes)
        for (const session of ['cap1', 'cap2', ''])
          for (const project of ['eng', ''])
            for (const flow of ['f1', 'f2', '', 7, null])
              for (const source of [undefined, 'mitm', 3])
                rows.push({ id: `r${n++}`, type, session, project, data: { subtype, ...(flow === null ? {} : { flow_id: flow }), ...(source === undefined ? {} : { source }) } })
    add(...rows)
    const sql = projection.httpExchangeSql('e')
    const keyed = db.getDB().prepare(`SELECT e.id, e.engagement_id, e.session_id, e.agent_type, e.data,
      CASE WHEN ${sql.eligible} THEN ${sql.key} END AS k FROM events_logged e`).all(...sql.params) as Array<{ id: string; engagement_id: string; session_id: string; agent_type: string; data: string; k: string | null }>
    const ak = (r: typeof keyed[number]): string => projection.activityKey({ id: r.id, engagementId: r.engagement_id, sessionId: r.session_id, agentType: r.agent_type, data: JSON.parse(r.data) })
    let http = 0
    for (const r of keyed) {
      const isHttp = JSON.parse(ak(r))[1] === 'http'
      expect(r.k !== null, `${r.id} ${r.agent_type} ${r.data} session=${r.session_id} project=${r.engagement_id}`).toBe(isHttp)
      if (isHttp) http++
    }
    expect(http).toBeGreaterThan(50)
    const eligible = keyed.filter(r => r.k !== null)
    for (const a of eligible) for (const b of eligible) expect(a.k === b.k, `${a.id} vs ${b.id}`).toBe(ak(a) === ak(b))
  })
})
