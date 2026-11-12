import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { searchHttpBodyEventIds, bodySearchCoverage, closeHttpBodyIndex, linkHttpBodyEvent, pruneHttpBodyIndex, pruneSavedFileIndex, eventIdsReferencingBody } from '../src/core/http-body-index'
import type { ExportSnapshot } from '../src/core/export-plan'

// #695: a text search used to re-walk every content-ref row and re-open and
// re-hash every saved file. It now does work for what changed since the last
// walk. The contract is that it answers exactly what the full walk answers.

let dir = ''
// While a scripted history is being played (see `play` below) the project and
// the index belong to that history across test cases, so the per-test cleanup
// must leave them alone; its own afterAll does the teardown.
let scripted = false
afterEach(() => {
  vi.restoreAllMocks()
  if (scripted) return
  closeHttpBodyIndex(); closeDB(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''
})

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
/** What a search under `snapshot` answers from: the index rows inside its
 *  boundary. The index also keeps rows linked above an older boundary (a
 *  bounded read leaves them out by position), so those are not part of what
 *  two runs must agree on. */
function dump(snapshot?: ExportSnapshot): unknown {
  const db = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
  const within = `((r.tier='events' AND r."row"<=@c) OR (r.tier='events_logged' AND r."row"<=@l))`
  const bound = { c: snapshot?.chainedMaxRowId ?? Number.MAX_SAFE_INTEGER, l: snapshot?.loggedMaxRowId ?? Number.MAX_SAFE_INTEGER }
  try {
    // Every row has a position once a search has run: an unplaced row would be
    // counted by an unbounded search and by coverage yet filtered out of the
    // comparison below, so it is asserted away here rather than ignored.
    expect(db.prepare(`SELECT event_id,sha256,status FROM body_event_refs WHERE tier IS NULL OR "row" IS NULL`).all(), 'unplaced index rows').toEqual([])
    return {
      // The verification columns hold inode and mtime signatures, which differ
      // between two runs by construction; everything else must agree.
      refs: db.prepare(`SELECT event_id,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes,tier,"row",engagement_id,refs,ref_bytes,c_idx,c_gn,c_gb,h1,h2
        FROM body_event_refs r WHERE ${within} ORDER BY event_id,sha256`).all(bound),
      fts: db.prepare(`SELECT event_id,sha256,content FROM body_fts f WHERE EXISTS(SELECT 1 FROM body_event_refs r WHERE r.event_id=f.event_id AND r.sha256=f.sha256 AND ${within})
        ORDER BY event_id,sha256,content`).all(bound),
    }
  } finally { db.close() }
}
const QUERIES = ['alpha', 'marker3', 'marker9', 'transcriptword', 'artifactword', 'inlineword', 'zzznothing']
/** incremental: one process throughout. restart: a new process before every
 *  search, the index DB kept. rebuild: a new process and no index DB, once
 *  per step. */
type Mode = 'incremental' | 'restart' | 'rebuild'
function observe(mode: Mode, snapshot?: ExportSnapshot): unknown {
  // What the index holds depends on the project and the boundary, never on
  // the query, so one rebuild per step is the from-scratch index every query
  // is answered from. Rebuilding it before each of the fourteen searches cost
  // fourteen index creations per step; on windows-latest that alone ran a step
  // past its timeout. The dump check below holds the reference to that: the
  // searches after the first must leave the rebuilt index exactly as it was.
  if (mode !== 'incremental') closeHttpBodyIndex()
  if (mode === 'rebuild') for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `http-body-index.db${suffix}`), { force: true })
  let built: unknown, firstCoverage: unknown
  const searches = QUERIES.flatMap(q => [false, true].map(excludeAiRaw => {
    if (mode === 'restart') closeHttpBodyIndex()
    const ids = searchHttpBodyEventIds(q, dir, excludeAiRaw, snapshot).sort()
    // Before any later search can bring the index back in line.
    if (firstCoverage === undefined) { firstCoverage = bodySearchCoverage(snapshot); built = dump(snapshot) }
    return [q, excludeAiRaw, ids]
  }))
  const observed = { searches, firstCoverage, coverage: bodySearchCoverage(snapshot), index: dump(snapshot) }
  if (mode === 'rebuild') expect(observed.index, 'the searches after the rebuild changed the rebuilt index').toEqual(built)
  // The rebuild reference above is from zero only for its first search. Each
  // step of every mode is also held to an index built from zero in another
  // place, which no incremental sync ever touches.
  else expect(fromZero(snapshot), `${mode}: a from-zero build`).toEqual({ alpha: searches[0][2], coverage: observed.coverage, index: observed.index })
  return observed
}
/** One search, the coverage and the dump from an index built from nothing, in
 *  a separate file; the project's own index is put back untouched after. */
function fromZero(snapshot?: ExportSnapshot): unknown {
  closeHttpBodyIndex()
  const live = path.join(dir, 'http-body-index.db'), aside = `${live}.aside`
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(live + suffix)) fs.renameSync(live + suffix, aside + suffix)
  try {
    return { alpha: searchHttpBodyEventIds('alpha', dir, false, snapshot).sort(), coverage: bodySearchCoverage(snapshot), index: dump(snapshot) }
  } finally {
    closeHttpBodyIndex()
    for (const suffix of ['', '-wal', '-shm']) { fs.rmSync(live + suffix, { force: true }); if (fs.existsSync(aside + suffix)) fs.renameSync(aside + suffix, live + suffix) }
  }
}

/** What a step leaves behind for the steps after it. */
interface History { refs: Record<string, ReturnType<typeof body>> }
/** One step of the scripted history: it changes the project and may return the
 *  export snapshot the observation after it is taken under. */
interface Step { name: string; apply: (h: History) => ExportSnapshot | void }

// Appended rows; two linked at write time the way ingest does.
const STEPS: Step[] = [
  { name: 'seeded', apply: ({ refs }) => {
    for (let i = 1; i <= 6; i++) refs[`e${i}`] = bodyEvent(`e${i}`, `alpha marker${i} chained`)
    for (let i = 1; i <= 4; i++) refs[`l${i}`] = bodyEvent(`l${i}`, `alpha marker${i + 10} logged`, 'events_logged')
    insert('e7', { response_body: { data: Buffer.from('alpha inlineword').toString('base64'), encoding: 'base64' } })
    insert('e8', { response_body_ref: body(Buffer.from([0, 1, 2, 255])) })
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'artifacts', 'a1.txt'), 'alpha artifactword')
    insert('a1', { stored: 'artifacts/a1.txt', sha256: sha('alpha artifactword'), size: 18 }, 'events', 'file_transfer', 'artifact_added')
    insert('c1', { sidecar_file: 'conv.jsonl' }, 'events', 'agent', 'transcript_capture_started')
  } },
  { name: 'unchanged', apply: () => {} },
  { name: 'appended', apply: ({ refs }) => {
    for (const id of ['e9', 'e10']) {
      refs[id] = bodyEvent(id, `alpha marker9 ${id}`)
      linkHttpBodyEvent({ id, data: { subtype: 'http_response', response_body_ref: refs[id] }, agentType: 'scanner' }, dir)
    }
    refs.l5 = bodyEvent('l5', 'alpha marker9 logged-five', 'events_logged')
  } },
  { name: 'deleted a row', apply: () => { getDB().prepare("DELETE FROM events_logged WHERE id='l2'").run() } },
  { name: 'rowid reused', apply: ({ refs }) => {
    // The highest rowid goes; the next insert reuses it with other content.
    getDB().prepare("DELETE FROM events_logged WHERE id='l5'").run()
    refs.l6 = bodyEvent('l6', 'alpha reused-rowid', 'events_logged')
  } },
  { name: 'evicted and pruned', apply: ({ refs }) => {
    fs.unlinkSync(path.join(dir, 'http-bodies', refs.e3.file))
    pruneHttpBodyIndex(refs.e3.sha256, dir)
  } },
  { name: 'pruned index only', apply: ({ refs }) => { pruneHttpBodyIndex(refs.e4.sha256, dir) } },
  { name: 'saved-file index pruned', apply: () => { pruneSavedFileIndex(path.join(dir, 'artifacts', 'a1.txt'), dir) } },
  { name: 'file removed', apply: ({ refs }) => { fs.unlinkSync(path.join(dir, 'http-bodies', refs.e5.file)) } },
  { name: 'file restored', apply: ({ refs }) => { fs.writeFileSync(path.join(dir, 'http-bodies', refs.e5.file), 'alpha marker5 chained') } },
  { name: 'same-size rewrite', apply: ({ refs }) => {
    const e6 = path.join(dir, 'http-bodies', refs.e6.file), stat = fs.statSync(e6)
    fs.writeFileSync(e6, 'gamma marker6 chained')
    fs.utimesSync(e6, stat.atime, stat.mtime)
  } },
  { name: 'pending transcript confirmed', apply: () => { transcript('t1', '{"m":"alpha transcriptword"}\n') } },
  { name: 'transcript grew', apply: () => { fs.appendFileSync(path.join(dir, 'agent-transcripts', 'conv.jsonl'), '{"m":"later"}\n') } },
  { name: 'newer transcript supersedes', apply: () => { transcript('t2', '{"m":"alpha transcriptword"}\n{"m":"later"}\n{"m":"newer"}\n') } },
  { name: 'export boundary', apply: () => ({
    chainedMaxRowId: (getDB().prepare("SELECT rowid AS r FROM events WHERE id='e9'").get() as { r: number }).r,
    loggedMaxRowId: (getDB().prepare("SELECT rowid AS r FROM events_logged WHERE id='l3'").get() as { r: number }).r,
    takenAt: 1,
  }) },
  // Same boundary, no change: the previous step's snapshot is reused below.
  { name: 'export boundary again', apply: () => {} },
  // Ingest links a new row while the last walk was bounded: the bounded
  // search must not report it, as the full walk's prune would not.
  { name: 'linked above the export boundary', apply: ({ refs }) => {
    refs.e11 = bodyEvent('e11', 'alpha marker9 eleven')
    linkHttpBodyEvent({ id: 'e11', data: { subtype: 'http_response', response_body_ref: refs.e11 }, agentType: 'scanner' }, dir)
  } },
  { name: 'live again', apply: () => {} },
  { name: 'live unchanged', apply: () => {} },
]
/** The steps whose observation is taken under the export boundary. */
const BOUNDED = new Set(['export boundary', 'export boundary again', 'linked above the export boundary'])

type Observed = { searches: unknown; coverage: { missing: number; failed: number; indexed: number }; index: unknown }
/** What the full rebuild answered at each step; the reference every other run is held to. */
const reference = new Map<string, Observed>()

/** Plays STEPS in order as one test case per step, in one project and (for
 *  `incremental`) one process. A step depends on the state the ones before it
 *  left, so once one fails the rest of this run are skipped rather than
 *  reported as misleading diffs. */
function play(mode: Mode): void {
  describe(`scripted history, ${mode}`, () => {
    const h: History = { refs: {} }
    let snapshot: ExportSnapshot | undefined, broken = ''
    beforeAll(() => {
      scripted = true
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-incremental-'))
      initDB(dir)
    })
    afterAll(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }); dir = ''; scripted = false })
    STEPS.forEach((step, i) => {
      it(`${mode}: step ${i + 1}/${STEPS.length} ${step.name}`, ctx => {
        if (broken) ctx.skip(`an earlier step of the ${mode} run failed (${broken}); this step builds on its state`)
        if (mode !== 'rebuild' && !reference.has(step.name)) ctx.skip('the rebuild reference for this step was not recorded')
        try {
          // One commit for the step's source rows, as ingest batches them; a
          // commit per row is a flush per row on a Windows runner.
          snapshot = getDB().transaction(() => step.apply(h))() ?? (BOUNDED.has(step.name) ? snapshot : undefined)
          const observed = observe(mode, snapshot) as Observed
          if (mode === 'rebuild') reference.set(step.name, observed)
          else expect(observed, `${mode}: ${step.name}`).toEqual(reference.get(step.name))
        } catch (e) { broken = step.name; throw e }
      })
    })
  })
}

describe('incremental body-search backfill', () => {
  // The reference is played first; the other two are compared to it step by step.
  play('rebuild')
  play('incremental')
  play('restart')

  it('the scripted history is not vacuous: each kind of change moves what is observed', () => {
    const at = (name: string): Observed['coverage'] => reference.get(name)!.coverage
    expect(at('file removed').missing).toBeGreaterThan(at('pruned index only').missing)
    expect(at('same-size rewrite').failed).toBe(1)
    expect(at('evicted and pruned').missing).toBe(1)
  })

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
      if (/^SELECT id,data,agent_type\b/.test(sql)) {
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

  it('after a restart with nothing changed, reads no row and opens no file', () => {
    seed(30)
    searchHttpBodyEventIds('alpha', dir)
    closeHttpBodyIndex()
    expect(work(() => expect(searchHttpBodyEventIds('work7', dir)).toEqual(['w7']))).toEqual({ opens: 0, rows: 0 })
    // A file changed while the app was closed is re-verified; nothing else is.
    fs.writeFileSync(path.join(dir, 'http-bodies', `${sha('alpha work4')}.body`), 'gamma work4 longer')
    closeHttpBodyIndex()
    expect(work(() => expect(searchHttpBodyEventIds('work4', dir)).toEqual([]))).toEqual({ opens: 1, rows: 1 })
  })

  // Every search surface takes a dataset snapshot of the current rowids, so
  // under live capture each search has a new boundary.
  const snap = (): ExportSnapshot => {
    const max = (t: string): number => (getDB().prepare(`SELECT coalesce(max(rowid),0) AS m FROM ${t}`).get() as { m: number }).m
    return { chainedMaxRowId: max('events'), loggedMaxRowId: max('events_logged'), takenAt: 1 }
  }
  it('under a new snapshot after an append, links only the appended rows', () => {
    seed(30)
    searchHttpBodyEventIds('alpha', dir, false, snap())
    for (let i = 30; i < 33; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    expect(work(() => expect(searchHttpBodyEventIds('work31', dir, false, snap())).toEqual(['w31']))).toEqual({ opens: 3, rows: 3 })
  })

  it('walks once after the watermark row is replaced, and not again', () => {
    seed(0)
    for (let i = 0; i < 5; i++) bodyEvent(`l${i}`, `alpha logged${i}`, 'events_logged')
    searchHttpBodyEventIds('alpha', dir)
    // Retention removes the highest logged row; the next insert reuses its
    // rowid for another Event.
    getDB().prepare("DELETE FROM events_logged WHERE id='l4'").run()
    bodyEvent('reused', 'alpha reusedword', 'events_logged')
    expect(work(() => expect(searchHttpBodyEventIds('reusedword', dir)).toEqual(['reused'])).rows).toBe(5)
    expect(work(() => searchHttpBodyEventIds('alpha', dir))).toEqual({ opens: 0, rows: 0 })
  })

  it('computes coverage without reading a source row or opening a file', () => {
    seed(30)
    const s = snap()
    searchHttpBodyEventIds('alpha', dir, false, s)
    let coverage: ReturnType<typeof bodySearchCoverage> | undefined
    expect(work(() => { coverage = bodySearchCoverage(s) })).toEqual({ opens: 0, rows: 0 })
    expect(coverage).toMatchObject({ indexed: 30, missing: 0, pending: 0, failed: 0 })
  })

  it('pages an older snapshot after an append without walking or re-verifying, and still bounds it', () => {
    seed(30)
    const older = snap()
    searchHttpBodyEventIds('alpha', dir, false, older)
    for (let i = 30; i < 33; i++) bodyEvent(`w${i}`, `alpha work${i}`)
    const newer = snap()
    searchHttpBodyEventIds('alpha', dir, false, newer)
    let ids: string[] = [], coverage: ReturnType<typeof bodySearchCoverage> | undefined
    expect(work(() => { ids = searchHttpBodyEventIds('alpha', dir, false, older); coverage = bodySearchCoverage(older) })).toEqual({ opens: 0, rows: 0 })
    expect(ids).toHaveLength(30)
    expect(ids).not.toContain('w31')
    expect(coverage).toMatchObject({ indexed: 30 })
    expect(work(() => { ids = searchHttpBodyEventIds('alpha', dir, false, newer); coverage = bodySearchCoverage(newer) })).toEqual({ opens: 0, rows: 0 })
    expect(ids).toHaveLength(33)
    expect(coverage).toMatchObject({ indexed: 33 })
  })

  it('does not trust coverage sums that disagree with the rows: it recounts them', () => {
    seed(10)
    const s = snap()
    searchHttpBodyEventIds('alpha', dir, false, s)
    const honest = bodySearchCoverage(s)
    const db = new Database(path.join(dir, 'http-body-index.db'))
    try { db.prepare("UPDATE body_coverage SET rows=rows+1,n=n+5 WHERE kind='body' AND status='indexed'").run() } finally { db.close() }
    expect(bodySearchCoverage(s)).toEqual(honest)
    const check = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try {
      expect(check.prepare('SELECT (SELECT count(*) FROM body_event_refs) AS refs,(SELECT sum(rows) FROM body_coverage) AS counted').get()).toEqual({ refs: 10, counted: 10 })
    } finally { check.close() }
  })

  it('does not re-read an evicted body on every search, and links it again when it comes back', () => {
    seed(5)
    searchHttpBodyEventIds('alpha', dir)
    const file = path.join(dir, 'http-bodies', `${sha('alpha work1')}.body`)
    fs.unlinkSync(file)
    pruneHttpBodyIndex(sha('alpha work1'), dir)
    // The prune's own Event is linked once, and found missing (before any open).
    expect(work(() => searchHttpBodyEventIds('work1', dir))).toEqual({ opens: 0, rows: 1 })
    expect(bodySearchCoverage().missing).toBe(1)
    expect(work(() => searchHttpBodyEventIds('work1', dir))).toEqual({ opens: 0, rows: 0 })
    fs.writeFileSync(file, 'alpha work1')
    expect(work(() => expect(searchHttpBodyEventIds('work1', dir)).toEqual(['w1']))).toEqual({ opens: 1, rows: 1 })
    expect(bodySearchCoverage().missing).toBe(0)
  })

  it('migrates a v7 index in place: no body is read again', () => {
    seed(10)
    searchHttpBodyEventIds('alpha', dir)
    const before = bodySearchCoverage()
    closeHttpBodyIndex()
    // Take the v8 additions back out, leaving exactly the v7 layout.
    const db = new Database(path.join(dir, 'http-body-index.db'))
    try {
      db.exec(`DROP TRIGGER body_coverage_insert; DROP TRIGGER body_coverage_delete; DROP TRIGGER body_coverage_update;
        DROP INDEX body_event_refs_position; DROP INDEX body_event_refs_verified; DROP INDEX body_event_refs_unverified;
        DROP INDEX body_event_refs_unplaced; DROP INDEX body_event_refs_ai_raw; DROP INDEX body_event_refs_bucket; DROP TABLE body_coverage; DROP TABLE body_relink;
        DELETE FROM body_index_meta WHERE key<>'directories'`)
      for (const column of ['engagement_id', 'row', 'refs', 'ref_bytes', 'c_idx', 'c_gn', 'c_gb', 'h1', 'h2']) db.exec(`ALTER TABLE body_event_refs DROP COLUMN "${column}"`)
      db.pragma('user_version=7')
      expect((db.prepare('PRAGMA table_info(body_event_refs)').all() as Array<{ name: string }>).map(c => c.name)).toEqual([
        'event_id', 'sha256', 'file', 'size', 'encoding', 'status', 'indexed_bytes', 'reason', 'kind', 'available_bytes', 'tier', 'verified_desc', 'verified_file', 'verified_sig'])
      expect((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'body_fts_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name))
        .toEqual(['body_event_refs', 'body_fts', 'body_index_meta'])
    } finally { db.close() }
    // One walk to place each row; every body keeps its verification.
    expect(work(() => expect(searchHttpBodyEventIds('work3', dir)).toEqual(['w3']))).toEqual({ opens: 0, rows: 10 })
    expect(bodySearchCoverage()).toEqual(before)
    expect(work(() => searchHttpBodyEventIds('work4', dir))).toEqual({ opens: 0, rows: 0 })
    const after = new Database(path.join(dir, 'http-body-index.db'), { readonly: true })
    try { expect(after.pragma('user_version', { simple: true })).toBe(9) } finally { after.close() }
  })

  /** Commit records appended to the index's WAL: each is a flush. */
  function walCommits(): number {
    const file = path.join(dir, 'http-body-index.db-wal')
    if (!fs.existsSync(file)) return 0
    const b = fs.readFileSync(file)
    if (b.length < 32) return 0
    const page = b.readUInt32BE(8)
    let n = 0
    for (let off = 32; off + 24 + page <= b.length; off += 24 + page) if (b.readUInt32BE(off + 4) !== 0) n++
    return n
  }
  it('opens an index already at its version without a write, and creates one in a single commit', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-open-'))
    initDB(dir)
    // A second handle keeps the WAL from being checkpointed away on close.
    eventIdsReferencingBody('none', dir)
    expect(walCommits()).toBe(1)
    const holder = new Database(path.join(dir, 'http-body-index.db'))
    try {
      closeHttpBodyIndex()
      const before = walCommits()
      eventIdsReferencingBody('none', dir)
      expect(walCommits() - before).toBe(0)
    } finally { holder.close() }
  })

  it('re-verifies only the file that changed', () => {
    seed(10)
    searchHttpBodyEventIds('alpha', dir)
    const file = path.join(dir, 'http-bodies', `${sha('alpha work4')}.body`)
    fs.writeFileSync(file, 'gamma work4')
    expect(work(() => expect(searchHttpBodyEventIds('work4', dir)).toEqual([]))).toEqual({ opens: 1, rows: 1 })
  })

  it('after a prune links again only the pruned ref\'s Event', () => {
    seed(10)
    searchHttpBodyEventIds('alpha', dir)
    pruneHttpBodyIndex(sha('alpha work2'), dir)
    expect(work(() => expect(searchHttpBodyEventIds('work2', dir)).toEqual(['w2']))).toEqual({ opens: 1, rows: 1 })
  })

  it('treats a row ingest already linked as a no-op at the next search', () => {
    seed(5)
    searchHttpBodyEventIds('alpha', dir)
    const ref = bodyEvent('fresh', 'alpha freshword')
    expect(work(() => linkHttpBodyEvent({ id: 'fresh', data: { subtype: 'http_response', response_body_ref: ref }, agentType: 'scanner' }, dir)).opens).toBe(1)
    expect(work(() => expect(searchHttpBodyEventIds('freshword', dir)).toEqual(['fresh']))).toEqual({ opens: 0, rows: 1 })
  })
})
