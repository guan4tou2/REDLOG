import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { searchHttpBodyEventIds, bodySearchCoverage, closeHttpBodyIndex, linkHttpBodyEvent, pruneHttpBodyIndex, pruneSavedFileIndex } from '../src/core/http-body-index'
import type { ExportSnapshot } from '../src/core/export-plan'

// #695: a text search used to re-walk every content-ref row and re-open and
// re-hash every saved file. It now does work for what changed since the last
// walk. The contract is that it answers exactly what the full walk answers.

let dir = ''
afterEach(() => { vi.restoreAllMocks(); closeHttpBodyIndex(); closeDB(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = '' })

type Tier = 'events' | 'events_logged'
function insert(id: string, data: Record<string, unknown>, tier: Tier = 'events', agentType = 'scanner', subtype = 'http_response'): void {
  getDB().prepare(`INSERT INTO ${tier} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at${tier === 'events' ? ',hash' : ''})
    VALUES (?,1,'project','capture','operator',?,?,'host',?,?${tier === 'events' ? ",'hash'" : ''})`).run(id, agentType, subtype, JSON.stringify({ subtype, ...data }), Number(id.replace(/\D/g, '')) || 1)
}
function body(text: string | Buffer): { sha256: string; file: string; size: number; encoding: 'text' } {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text)
  const sha256 = createHash('sha256').update(bytes).digest('hex'), file = `${sha256}.body`
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'http-bodies', file), bytes)
  return { sha256, file, size: bytes.length, encoding: 'text' }
}
function bodyEvent(id: string, text: string, tier: Tier = 'events'): ReturnType<typeof body> {
  const ref = body(text)
  insert(id, { response_body_ref: ref }, tier)
  return ref
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
function transcript(id: string, text: string): void {
  fs.mkdirSync(path.join(dir, 'agent-transcripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-transcripts', 'conv.jsonl'), text)
  insert(id, { snapshot_path: 'agent-transcripts/conv.jsonl', cumulative_bytes: Buffer.byteLength(text), cumulative_sha256: sha(text) }, 'events', 'agent', 'transcript_snapshot')
}
function dump(): unknown {
  const db = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
  try {
    return {
      refs: db.prepare('SELECT * FROM body_event_refs ORDER BY event_id,sha256').all(),
      fts: db.prepare('SELECT event_id,sha256,content FROM body_fts ORDER BY event_id,sha256,content').all(),
    }
  } finally { db.close() }
}
const QUERIES = ['alpha', 'marker3', 'marker9', 'transcriptword', 'artifactword', 'inlineword', 'zzznothing']
function observe(fresh: boolean, snapshot?: ExportSnapshot): unknown {
  const searches = QUERIES.flatMap(q => [false, true].map(excludeAiRaw => {
    // A fresh process: the index on disk survives, nothing in memory does.
    if (fresh) closeHttpBodyIndex()
    return [q, excludeAiRaw, searchHttpBodyEventIds(q, dir, excludeAiRaw, snapshot).sort()]
  }))
  return { searches, coverage: bodySearchCoverage(snapshot), index: dump() }
}

/** One scripted history. Every step ends with an observation. */
function scenario(fresh: boolean): Array<[string, unknown]> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-incremental-'))
  initDB(dir)
  const out: Array<[string, unknown]> = []
  const step = (name: string, snapshot?: ExportSnapshot): void => { out.push([name, observe(fresh, snapshot)]) }
  const refs: Record<string, ReturnType<typeof body>> = {}
  for (let i = 1; i <= 6; i++) refs[`e${i}`] = bodyEvent(`e${i}`, `alpha marker${i} chained`)
  for (let i = 1; i <= 4; i++) refs[`l${i}`] = bodyEvent(`l${i}`, `alpha marker${i + 10} logged`, 'events_logged')
  insert('e7', { response_body: { data: Buffer.from('alpha inlineword').toString('base64'), encoding: 'base64' } })
  insert('e8', { response_body_ref: body(Buffer.from([0, 1, 2, 255])) })
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'artifacts', 'a1.txt'), 'alpha artifactword')
  insert('a1', { stored: 'artifacts/a1.txt', sha256: sha('alpha artifactword'), size: 18 }, 'events', 'file_transfer', 'artifact_added')
  insert('c1', { sidecar_file: 'conv.jsonl' }, 'events', 'agent', 'transcript_capture_started')
  step('seeded')
  step('unchanged')

  // Appended rows; two linked at write time the way ingest does.
  for (const id of ['e9', 'e10']) {
    refs[id] = bodyEvent(id, `alpha marker9 ${id}`)
    linkHttpBodyEvent({ id, data: { subtype: 'http_response', response_body_ref: refs[id] }, agentType: 'scanner' }, dir)
  }
  refs.l5 = bodyEvent('l5', 'alpha marker9 logged-five', 'events_logged')
  step('appended')

  getDB().prepare("DELETE FROM events_logged WHERE id='l2'").run()
  step('deleted a row')
  // The highest rowid goes; the next insert reuses it with other content.
  getDB().prepare("DELETE FROM events_logged WHERE id='l5'").run()
  refs.l6 = bodyEvent('l6', 'alpha reused-rowid', 'events_logged')
  step('rowid reused')

  fs.unlinkSync(path.join(dir, 'http-bodies', refs.e3.file))
  pruneHttpBodyIndex(refs.e3.sha256, dir)
  step('evicted and pruned')
  pruneHttpBodyIndex(refs.e4.sha256, dir)
  step('pruned index only')
  pruneSavedFileIndex(path.join(dir, 'artifacts', 'a1.txt'), dir)
  step('saved-file index pruned')

  fs.unlinkSync(path.join(dir, 'http-bodies', refs.e5.file))
  step('file removed')
  fs.writeFileSync(path.join(dir, 'http-bodies', refs.e5.file), 'alpha marker5 chained')
  step('file restored')
  const e6 = path.join(dir, 'http-bodies', refs.e6.file), stat = fs.statSync(e6)
  fs.writeFileSync(e6, 'gamma marker6 chained')
  fs.utimesSync(e6, stat.atime, stat.mtime)
  step('same-size rewrite')

  transcript('t1', '{"m":"alpha transcriptword"}\n')
  step('pending transcript confirmed')
  fs.appendFileSync(path.join(dir, 'agent-transcripts', 'conv.jsonl'), '{"m":"later"}\n')
  step('transcript grew')
  transcript('t2', '{"m":"alpha transcriptword"}\n{"m":"later"}\n{"m":"newer"}\n')
  step('newer transcript supersedes')

  const boundary: ExportSnapshot = {
    chainedMaxRowId: (getDB().prepare("SELECT rowid AS r FROM events WHERE id='e9'").get() as { r: number }).r,
    loggedMaxRowId: (getDB().prepare("SELECT rowid AS r FROM events_logged WHERE id='l3'").get() as { r: number }).r,
    takenAt: 1,
  }
  step('export boundary', boundary)
  step('export boundary again', boundary)
  // Ingest links a new row while the last walk was bounded: the bounded
  // search must not report it, as the full walk's prune would not.
  refs.e11 = bodyEvent('e11', 'alpha marker9 eleven')
  linkHttpBodyEvent({ id: 'e11', data: { subtype: 'http_response', response_body_ref: refs.e11 }, agentType: 'scanner' }, dir)
  step('linked above the export boundary', boundary)
  step('live again')
  step('live unchanged')
  closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }); dir = ''
  return out
}

describe('incremental body-search backfill', () => {
  it('answers exactly what a fresh full walk answers, after every kind of change', () => {
    const incremental = scenario(false), fresh = scenario(true)
    expect(incremental.map(([name]) => name)).toEqual(fresh.map(([name]) => name))
    for (const [i, [name, observed]] of incremental.entries()) expect(observed, name).toEqual(fresh[i][1])
    // The scenario is not vacuous: each kind of change moves what is observed.
    const at = (name: string): { coverage: { missing: number; failed: number; indexed: number } } =>
      incremental.find(([n]) => n === name)![1] as { coverage: { missing: number; failed: number; indexed: number } }
    expect(at('file removed').coverage.missing).toBeGreaterThan(at('pruned index only').coverage.missing)
    expect(at('same-size rewrite').coverage.failed).toBe(1)
    expect(at('evicted and pruned').coverage.missing).toBe(1)
  }, 60_000)

  function seed(n: number): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-work-'))
    initDB(dir)
    for (let i = 0; i < n; i++) bodyEvent(`w${i}`, `alpha work${i}`)
  }
  /** File opens under the project, and source rows read by the index. */
  function work(run: () => void): { opens: number; rows: number } {
    let opens = 0, rows = 0
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file).startsWith(dir)) opens++
      return (open as (...a: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync)
    const prepare = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      const s = prepare.call(this, sql)
      if (/^SELECT id,data,agent_type FROM/.test(sql)) {
        const iterate = s.iterate.bind(s), get = s.get.bind(s)
        ;(s as unknown as { iterate: (...a: unknown[]) => unknown }).iterate = function* (...a: unknown[]) { for (const r of iterate(...a)) { rows++; yield r } }
        ;(s as unknown as { get: (...a: unknown[]) => unknown }).get = (...a: unknown[]) => { const r = get(...a); if (r) rows++; return r }
      }
      return s
    })
    try { run() } finally { vi.restoreAllMocks() }
    return { opens, rows }
  }

  it('does no verification and reads no rows when nothing changed, and only the new rows after an append', () => {
    seed(30)
    expect(work(() => searchHttpBodyEventIds('alpha', dir))).toEqual({ opens: 30, rows: 30 })
    expect(work(() => searchHttpBodyEventIds('work7', dir))).toEqual({ opens: 0, rows: 0 })
    for (let i = 30; i < 33; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    expect(work(() => expect(searchHttpBodyEventIds('work31', dir)).toEqual(['w31']))).toEqual({ opens: 3, rows: 3 })
    expect(work(() => searchHttpBodyEventIds('alpha', dir))).toEqual({ opens: 0, rows: 0 })
  })

  it('re-verifies only the file that changed', () => {
    seed(10)
    searchHttpBodyEventIds('alpha', dir)
    const file = path.join(dir, 'http-bodies', `${sha('alpha work4')}.body`)
    fs.writeFileSync(file, 'gamma work4')
    expect(work(() => expect(searchHttpBodyEventIds('work4', dir)).toEqual([]))).toEqual({ opens: 1, rows: 1 })
  })

  it('walks every row after a prune but re-verifies only the pruned ref', () => {
    seed(10)
    searchHttpBodyEventIds('alpha', dir)
    pruneHttpBodyIndex(sha('alpha work2'), dir)
    expect(work(() => expect(searchHttpBodyEventIds('work2', dir)).toEqual(['w2']))).toEqual({ opens: 1, rows: 10 })
  })

  it('treats a row ingest already linked as a no-op at the next search', () => {
    seed(5)
    searchHttpBodyEventIds('alpha', dir)
    const ref = bodyEvent('fresh', 'alpha freshword')
    expect(work(() => linkHttpBodyEvent({ id: 'fresh', data: { subtype: 'http_response', response_body_ref: ref }, agentType: 'scanner' }, dir)).opens).toBe(1)
    expect(work(() => expect(searchHttpBodyEventIds('freshword', dir)).toEqual(['fresh']))).toEqual({ opens: 0, rows: 1 })
  })
})
