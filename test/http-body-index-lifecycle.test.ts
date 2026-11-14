// The body index's lifecycle, pinned by a seeded random sequence against a
// model, because three review rounds each found a lifecycle bug that example
// tests missed. Operations: ingest a row with no body, a response with a saved
// body, one with an inline escaped body, one whose request and response are the
// same bytes; search under a fresh snapshot and under an older one; a live
// count and match; a search by a second module instance (its own index
// connection) bounded by an older snapshot; a real worker opened read-only with
// one read transaction, as the export worker is, whose view falls behind; a saved
// body that vanishes, or vanishes mid-read, and comes back; an HTTP exchange
// whose request holds one word and whose response body another.
//
// After every search or count:
//  (a) the answer is the model's (every term in the event's fields or in a body
//      of it that still exists, the last term a prefix; for a row of an HTTP
//      exchange, every term somewhere in the exchange's rows that the view
//      holds and at least one in the row itself), or body coverage is not
//      `covered`;
//  (b) the source rows main's index read are bounded by the content rows added
//      since its previous sync plus the refs retried every time (missing and
//      failed), never by the project's size;
//  (c) live coverage counts one ref per body the model has.
// At the end, and after every step: every document's rowid decodes to a ref
// whose recorded counts cover it, every counted document exists (so documents
// and counts match one to one), only a ref with text has documents, and the
// index passes SQLite's integrity check.
//
// REDLOG_LIFECYCLE_SEED=<n> replays one seed.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { cost, parsed, escapeNonAscii } from './helpers/body-index-work'
import { openFrozenReader, type FrozenReader } from './helpers/frozen-export-reader'
import { layoutViolations } from './helpers/body-index-layout'
import type { ExportSnapshot } from '../src/core/export-plan'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db')
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
let ingest: typeof import('../src/core/ingest').ingest
let readActivitySnapshot: typeof import('../src/core/db/dataset-snapshot').readActivitySnapshot
if (sqlite.ok) {
  db = await import('../src/core/db')
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
  ingest = (await import('../src/core/ingest')).ingest
  readActivitySnapshot = (await import('../src/core/db/dataset-snapshot')).readActivitySnapshot
}

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Body { file: string | null; words: string[] }
/** `deleted`: the step retention deleted the row at. `flow`: the exchange it
 *  is a row of (one capture session, one source, so the flow id is the key). */
interface Modelled { id: string; tier: 'events' | 'events_logged'; rowid: number; fields: string[]; bodies: Body[]; deleted?: number; flow?: string }

const SEEDS = process.env.REDLOG_LIFECYCLE_SEED ? [Number(process.env.REDLOG_LIFECYCLE_SEED)] : [1, 2, 3]
const STEPS = 300
let dir = ''

sqlite.describe('body index lifecycle, seeded', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-life-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it.each(SEEDS)('seed %i', async seed => {
    const random = prng(seed), pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]
    const model: Modelled[] = []
    const gone = new Map<string, string>() // file → content, while vanished
    const exchanges: number[] = [] // the k of each exchange added
    let n = 0, addedSince = 0, step = 0, op = ''
    const where = (): string => `seed ${seed}, step ${step} (${op})`

    const rowOf = (id: string): Pick<Modelled, 'tier' | 'rowid'> => {
      for (const tier of ['events', 'events_logged'] as const) {
        const row = db.getDB().prepare(`SELECT rowid AS r FROM ${tier} WHERE id=?`).get(id) as { r: number } | undefined
        if (row) return { tier, rowid: row.r }
      }
      throw new Error(`${id} not written`)
    }
    const save = (text: string): { sha256: string; file: string; size: number; encoding: 'text' } => {
      const sha256 = createHash('sha256').update(text).digest('hex'), file = `${sha256}.body`
      fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'http-bodies', file), text)
      return { sha256, file, size: Buffer.byteLength(text), encoding: 'text' }
    }
    const post = (agentType: string, data: Record<string, unknown>, fields: string[], bodies: Body[]): void => {
      const event = ingest({ agentType, engagementId: 'eng', operatorId: 'op', data }).event!, id = event.id
      // Ingest links a response to its request (`_causes`), and the events
      // index tokenizes that id: its hex words are words of the row, which a
      // prefix such as "b64" can match.
      const causes = Array.isArray(event.data._causes) ? (event.data._causes as unknown[]).flatMap(c => String(c).toLowerCase().split(/[^0-9a-z]+/)).filter(Boolean) : []
      model.push({ id, ...rowOf(id), fields: [...fields, ...causes], bodies, ...(typeof data.flow_id === 'string' ? { flow: data.flow_id } : {}) })
      if (bodies.length) addedSince++
    }
    const add = {
      bodiless: () => { const k = n++; post('shell', { subtype: 'command_end', command: `echo f${k}` }, ['echo', `f${k}`], []) },
      saved: () => {
        const k = n++, ref = save(`{"v":"b${k} shared words"}`)
        post('scanner', { subtype: 'http_response', url: `http://h${k}.test/`, response_body_ref: ref }, ['http', `h${k}`, 'test'], [{ file: ref.file, words: ['v', `b${k}`, 'shared', 'words'] }])
      },
      inline: () => {
        const k = n++, text = `{"v":"${escapeNonAscii(`e${k} 新詞`)}"}`
        post('scanner', { subtype: 'http_response', url: `http://h${k}.test/`,
          response_body: { data: text, encoding: 'text', size: Buffer.byteLength(text), truncated: false, content_type: 'application/json' } },
        ['http', `h${k}`, 'test', 'v', `e${k}`, '新詞'], [{ file: null, words: ['v', `e${k}`, '新詞'] }])
      },
      same: () => {
        const k = n++, ref = save(`{"echo":"s${k} echoed"}`)
        post('scanner', { subtype: 'http_response', url: `http://h${k}.test/`, request_body_ref: ref, response_body_ref: ref }, ['http', `h${k}`, 'test'],
          [{ file: ref.file, words: ['echo', `s${k}`, 'echoed'] }, { file: ref.file, words: ['echo', `s${k}`, 'echoed'] }])
      },
      // One exchange: a word in the request URL, another in the response body.
      exchange: () => {
        const k = n++, flow = `x${k}`, ref = save(`{"v":"r${k} shared words"}`)
        exchanges.push(k)
        post('scanner', { subtype: 'http_request_start', flow_id: flow, url: `http://h${k}.test/q${k}` }, ['http', `h${k}`, 'test', `q${k}`, flow], [])
        post('scanner', { subtype: 'http_response', flow_id: flow, url: `http://h${k}.test/q${k}`.replace(`/q${k}`, '/'), response_body_ref: ref }, ['http', `h${k}`, 'test', flow],
          [{ file: ref.file, words: ['v', `r${k}`, 'shared', 'words'] }])
      },
    }
    // The starting project in one commit (a commit per row is a flush per row on Windows).
    db.getDB().transaction(() => {
      for (let i = 0; i < 60; i++) add.bodiless()
      for (let i = 0; i < 60; i++) add.saved()
      for (let i = 0; i < 30; i++) add.inline()
      for (let i = 0; i < 3; i++) add.same()
      for (let i = 0; i < 20; i++) add.exchange()
    })()

    /** What a correct index answers for `text`, inside `snapshot` if given,
     *  for a view taken at step `seenAt` (default: now). */
    const oracle = (text: string, snapshot?: ExportSnapshot, seenAt = Infinity): string[] => {
      const terms = text.split(' ')
      const has = (words: string[], term: string, last: boolean) => words.some(w => last ? w.startsWith(term) : w === term)
      const holds = (e: Modelled, term: string, i: number): boolean => has(e.fields, term, i === terms.length - 1)
        || e.bodies.some(b => (b.file === null || !gone.has(b.file)) && has(b.words, term, i === terms.length - 1))
      const seen = model.filter(e => e.deleted === undefined || e.deleted >= seenAt)
        .filter(e => !snapshot || e.rowid <= (e.tier === 'events' ? snapshot.chainedMaxRowId : snapshot.loggedMaxRowId))
      return seen.filter(e => {
        const unit = e.flow === undefined ? [e] : seen.filter(u => u.flow === e.flow)
        return terms.every((term, i) => unit.some(u => holds(u, term, i))) && terms.some((term, i) => holds(e, term, i))
      }).map(e => e.id).sort()
    }
    const query = (): string => {
      const e = pick(model.filter(m => m.bodies.length && m.deleted === undefined)), body = e.bodies[0].words[1], x = pick(exchanges)
      return pick([body, `${e.fields[1]} ${body}`, `${body} ${e.fields[1]}`, `zz${n}`, 'shared words', 'echoed', `q${x} r${x}`, `r${x} q${x}`, `q${x} shared`])
    }
    const bodyCoverage = (snapshot?: ExportSnapshot) => idx.bodySearchCoverage(snapshot).sources!.find(s => s.kind === 'body')!
    /** Missing refs are retried by every sync, by design: the ones gone now,
     *  and the ones restored since the last sync (still missing in the index). */
    const missingSinceSync = new Set<string>()
    const retried = (): number => model.filter(e => e.deleted === undefined).reduce((sum, e) => sum + e.bodies.filter(b => b.file && (gone.has(b.file) || missingSinceSync.has(b.file))).length, 0)
    /** (b) and the model checks for one call through main's index. */
    function checked<T>(run: () => T): T {
      const counted = cost(run)
      // Rows deleted under the watermark: the next sync walks, by design.
      if (!walkExpected) expect(counted.rows, `${where()}: source rows read`).toBeLessThanOrEqual(addedSince + retried() + 3)
      walkExpected = false
      addedSince = 0
      missingSinceSync.clear(); for (const f of gone.keys()) missingSinceSync.add(f)
      return counted.result
    }
    function agree(answer: string[], text: string, snapshot?: ExportSnapshot): void {
      // Without a snapshot: coverage at the current maxima, as a search asks it.
      const expected = oracle(text, snapshot), read = cost(() => bodyCoverage(snapshot ?? readActivitySnapshot(db.getReadonlyDB()))), coverage = read.result
      expect(read.rows, `${where()}: source rows coverage read`).toBeLessThanOrEqual(3)
      if (coverage.status === 'covered') { compared++; if (expected.length) found++ }
      if (coverage.status === 'covered') expect(answer.sort(), `${where()}: "${text}" while coverage says covered`).toEqual(expected)
      if (!snapshot) expect(coverage.indexed + coverage.missing + coverage.failed + coverage.pending + coverage.partial + coverage.binary + coverage.limited,
        `${where()}: refs counted`).toBe(model.filter(e => e.deleted === undefined).reduce((sum, e) => sum + e.bodies.length, 0))
    }
    function documentsHold(): void {
      const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
      try {
        // stray: documents no ref accounts for; missing: counted documents
        // that are not there; textless: documents of a ref without text.
        expect(layoutViolations(index), `${where()}: documents and the refs that count them`).toEqual({ stray: 0, missing: 0, textless: 0 })
        expect(index.pragma('integrity_check'), `${where()}: integrity`).toEqual([{ integrity_check: 'ok' }])
      } finally { index.close() }
    }

    let compared = 0, found = 0
    let older: ExportSnapshot = readActivitySnapshot(db.getReadonlyDB())
    let other: { db: typeof db; queries: typeof queries; idx: typeof idx } | null = null
    let frozen: FrozenReader | null = null, frozenAt = 0, frozenBehindRetention = false, walkExpected = false
    const sharedState = (): unknown => {
      const index = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
      try {
        return { refs: index.prepare('SELECT count(*) AS n FROM body_event_refs').get(), docs: index.prepare('SELECT count(*) AS n FROM body_fts').get(),
          mark: index.prepare("SELECT value FROM body_index_meta WHERE key='mark'").get() }
      } finally { index.close() }
    }
    try {
      checked(() => queries.executeEventQuery({ parsed: parsed('shared'), filter: {}, limit: 1 }))
      for (step = 0; step < STEPS; step++) {
        const r = random()
        if (r < 0.10) { op = 'bodiless'; add.bodiless() }
        else if (r < 0.18) { op = 'saved'; add.saved() }
        else if (r < 0.24) { op = 'inline'; add.inline() }
        else if (r < 0.26) { op = 'same'; add.same() }
        else if (r < 0.28) { op = 'exchange'; add.exchange() }
        else if (r < 0.31) { op = 'older snapshot'; older = readActivitySnapshot(db.getReadonlyDB()) }
        else if (r < 0.50) {
          op = 'search'; const text = query()
          const page = checked(() => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 500 }))
          agree(page.items.map(e => e.id), text)
        } else if (r < 0.60) {
          op = 'search older'; const text = query()
          const page = checked(() => queries.executeEventQuery({ parsed: parsed(text), filter: {}, snapshot: older, limit: 500 }))
          agree(page.items.map(e => e.id), text, older)
        } else if (r < 0.70) {
          op = 'count and match'; const text = query()
          const count = checked(() => queries.countEvents({ parsed: parsed(text), filter: {} }))
          const ids = model.slice(-200).map(e => e.id)
          const matched = checked(() => queries.matchEventIds({ parsed: parsed(text), filter: {}, ids }))
          const expected = oracle(text)
          if (bodyCoverage().status === 'covered') {
            expect(count, `${where()}: count of "${text}"`).toBe(expected.length)
            expect(matched.sort(), `${where()}: match of "${text}"`).toEqual(expected.filter(id => ids.includes(id)))
          }
        } else if (r < 0.73) {
          // The export worker: read-only, one read transaction for its life,
          // so its view falls behind while main goes on.
          op = 'frozen reader'
          if (!frozen || random() < 0.3) { await frozen?.close(); frozen = await openFrozenReader(dir, 'eng'); frozenAt = step; frozenBehindRetention = walkExpected }
          const before = sharedState(), text = query()
          const answer = await frozen.search(text)
          if (answer.coverage.status === 'covered') expect(answer.ids, `${where()}: frozen reader, "${text}"`).toEqual(oracle(text, frozen.snapshot, frozenAt))
          // When the shared index does not vouch for its view (retention
          // deleted rows its view still has, or main has not walked since a
          // deletion its view already shows), its first search reads that
          // view into TEMP; then it is bounded again.
          if (!frozenBehindRetention) expect(answer.rows, `${where()}: source rows the frozen reader read`).toBeLessThanOrEqual(40)
          frozenBehindRetention = false
          expect(sharedState(), `${where()}: the frozen reader wrote the shared index`).toEqual(before)
        } else if (r < 0.75) {
          op = 'other instance, older snapshot'
          if (!other) {
            vi.resetModules()
            other = { db: await import('../src/core/db'), queries: await import('../src/core/db/event-queries'), idx: await import('../src/core/http-body-index') }
            other.db.initDB(dir)
          }
          // As an export preview runs while main searches: main, the other
          // instance under its older snapshot, then main again, nothing between.
          const text = query()
          agree(checked(() => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 500 })).items.map(e => e.id), text)
          const page = other.queries.executeEventQuery({ parsed: parsed(text), filter: {}, snapshot: older, limit: 500 })
          const coverage = other.idx.bodySearchCoverage(older).sources!.find(s => s.kind === 'body')!
          if (coverage.status === 'covered') expect(page.items.map(e => e.id).sort(), `${where()}: other instance, "${text}"`).toEqual(oracle(text, older))
          agree(checked(() => queries.executeEventQuery({ parsed: parsed(text), filter: {}, limit: 500 })).items.map(e => e.id), text)
        } else if (r < 0.77) {
          // Retention on the logged tier: the oldest rows go, as sweepLoggedTier deletes them.
          op = 'retention'
          const doomed = db.getDB().prepare('SELECT id FROM events_logged ORDER BY created_at,rowid LIMIT ?').all(1 + Math.floor(random() * 5)) as { id: string }[]
          db.getDB().prepare(`DELETE FROM events_logged WHERE rowid IN (SELECT rowid FROM events_logged ORDER BY created_at,rowid LIMIT ${doomed.length})`).run()
          for (const { id } of doomed) { const e = model.find(m => m.id === id); if (e) e.deleted = step }
          // A snapshot from before the deletion is refused ("changed by retention"): take a new one.
          older = readActivitySnapshot(db.getReadonlyDB())
          walkExpected = true
          if (frozen) frozenBehindRetention = true
        } else if (r < 0.79) {
          op = 'vanish'
          const files = model.flatMap(e => e.bodies.map(b => b.file)).filter((f): f is string => !!f && !gone.has(f))
          if (files.length) { const f = pick(files), file = path.join(dir, 'http-bodies', f); gone.set(f, fs.readFileSync(file, 'utf8')); fs.rmSync(file) }
        } else if (r < 0.93) {
          op = 'restore'
          if (gone.size) { const [f, text] = pick([...gone]); fs.writeFileSync(path.join(dir, 'http-bodies', f), text); gone.delete(f) }
        } else {
          // A body file that disappears while it is read, at the next search.
          op = 'vanish mid-read'
          const files = model.flatMap(e => e.bodies.map(b => b.file)).filter((f): f is string => !!f && gone.has(f))
          if (files.length) {
            const f = pick(files), file = path.join(dir, 'http-bodies', f), text = gone.get(f)!
            fs.writeFileSync(file, text)
            let reading = false
            const readSync = fs.readSync, lstatSync = fs.lstatSync
            vi.spyOn(fs, 'readSync').mockImplementation(((...a: unknown[]) => { reading = true; return (readSync as (...b: unknown[]) => number)(...a) }) as typeof fs.readSync)
            vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
              if (reading && String(p) === file) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
              return (lstatSync as (...b: unknown[]) => fs.Stats)(p, ...rest)
            }) as typeof fs.lstatSync)
            const textQuery = query()
            try {
              const page = checked(() => queries.executeEventQuery({ parsed: parsed(textQuery), filter: {}, limit: 500 }))
              agree(page.items.map(e => e.id), textQuery)
            } finally { vi.restoreAllMocks() }
            fs.rmSync(file)
          }
        }
        documentsHold()
      }
      for (const [f, text] of gone) fs.writeFileSync(path.join(dir, 'http-bodies', f), text)
      gone.clear(); op = 'final search'
      const page = checked(() => queries.executeEventQuery({ parsed: parsed('shared words'), filter: {}, limit: 500 }))
      agree(page.items.map(e => e.id), 'shared words')
      documentsHold()
      // Not vacuous: answers were held to the model while covered, and hits among them.
      expect({ compared: compared > 20, found: found > 10 }, `seed ${seed}: compared ${compared}, found ${found}`).toEqual({ compared: true, found: true })
    } finally { await frozen?.close(); if (other) { other.idx.closeHttpBodyIndex(); other.db.closeDB() } }
  }, 30_000)
})
