// Spec 071 FR-022–024 end to end: both verifiers report the same receiver-
// provenance counts for real bundles, from every export path, and the counts
// never move a verdict or an exit code.
//
// The project is a copy of test/fixtures/golden-pre071's (rows written before
// the stamp, in a session whose start has none), opened by current code and
// given three more sessions: one with a stamped start and stamped rows in both
// tiers, one with rows and no start, and the one the exports' own rows (logged
// digest, seal) are written in, whose start is stamped. The new rows are
// unsigned (the fixture's signer key is not kept), so both verifiers run
// hash-only; the counts do not depend on that.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))
import { requires } from './helpers/requires'
import { ENG, OP, VERIFIER, pythonBin } from './fixtures/golden-pre071-generate'
import { pythonProvenance, pythonProvenanceBlock } from './helpers/provenance-report'
import type { ProvenanceCounts } from '../src/core/evidence-rules'

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')
const GOLDEN = path.join(__dirname, 'fixtures', 'golden-pre071', 'project')
const tmps: string[] = []
const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-provenance-report-${label}-`)); tmps.push(d); return d }

type Verdict = import('../src/core/bundle-verify').BundleVerdict
interface Judged { ts: Verdict; py: { status: number | null; out: string } | null }
const PATHS = ['whole project', 'time range', 'selection, all rows', 'selection, current results', 'selection, a search', 'activity', 'source session'] as const
type ExportPath = typeof PATHS[number]

const copyBundle = (dir: string): string => { const d = path.join(tmp('copy'), 'bundle'); fs.cpSync(dir, d, { recursive: true }); return d }
const lines = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

sqlite.describe('receiver provenance in both verifiers, from every export path', () => {
  const bundles = new Map<ExportPath, string>()
  let verifyBundleDir: typeof import('../src/core/bundle-verify').verifyBundleDir
  const prevKeys = process.env.REDLOG_KEYS_DIR

  const judge = (dir: string): Judged => {
    const ts = verifyBundleDir(dir, { hashOnly: true })
    if (!python.ok) return { ts, py: null }
    const r = spawnSync(pythonBin, ['-I', VERIFIER, '--hash-only', dir], { encoding: 'utf8' })
    return { ts, py: { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') } }
  }

  beforeAll(async () => {
    process.env.REDLOG_KEYS_DIR = tmp('keys')
    const projectDir = path.join(tmp('project'), 'project')
    fs.cpSync(GOLDEN, projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'config.yaml'), `engagement:\n  id: ${ENG}\n`)
    const db = await import('../src/core/db/index')
    const events = await import('../src/core/db/events')
    const ingestMod = await import('../src/core/ingest')
    const { LEGACY_API } = await import('../src/core/ingest/stamp')
    const { registerDataExportIpc } = await import('../src/main/ipc/data-export')
    const { ExportPlanRegistry } = await import('../src/core/export-plan')
    const { queryActivityPage } = await import('../src/core/db/activity-queries')
    const { parseQuery } = await import('../src/core/query/contract')
    const { closeHttpBodyIndex } = await import('../src/core/http-body-index')
    // The worker's kernel, in process: the same code the export worker runs.
    const { executeExportTask } = await import('../src/core/export-task')
    verifyBundleDir = (await import('../src/core/bundle-verify')).verifyBundleDir

    db.initDB(projectDir)
    db.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    const who = { engagementId: ENG, operatorId: OP }
    const api = (agentType: string, data: Record<string, unknown>): string => {
      const r = ingestMod.ingest({ agentType, data, ...who, entrance: LEGACY_API, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
      if (!r.event) throw new Error(`not written: ${agentType}.${String(data.subtype)}`)
      return r.event.id
    }
    const since = Date.now() - 1
    // A session as current code writes it: its start, stamped, comes first.
    events.insertEvent('system', { subtype: 'session_start' }, who)
    const anchor = api('shell', { subtype: 'command_start', command: 'nmap -p 80 10.0.0.9', shell: 'zsh', terminalId: 't-prov', pid: 7001, command_id: 'c-prov' })
    api('scanner', { subtype: 'http_request_start', flow_id: 'f-prov', method: 'GET', url: 'http://10.0.0.9/' })
    // A session whose start is in no bundle.
    events.resetSession()
    api('shell', { subtype: 'command_start', command: 'id', terminalId: 't-orphan', pid: 7002 })
    api('scanner', { subtype: 'http_request_start', flow_id: 'f-orphan', method: 'GET', url: 'http://10.0.0.9/orphan' })
    // The session the exports write their own rows in.
    events.resetSession()
    events.insertEvent('system', { subtype: 'session_start' }, who)
    const before = Date.now() + 1

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerDataExportIpc({ handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } as never,
      { getActiveProject: () => ({ id: ENG, path: projectDir }) } as never, { planRegistry: new ExportPlanRegistry(), runTask: async (task) => executeExportTask(task) })
    const parsed = parseQuery(''); if (!parsed.ok) throw new Error('query')
    const snapshot = queryActivityPage({ projectId: ENG, parsed: parsed.parsed }).snapshot
    const requests: Record<ExportPath, Record<string, unknown>> = {
      'whole project': { kind: 'all' },
      'time range': { kind: 'time-range', since, before },
      'selection, all rows': { kind: 'selection', projection: 'events', filter: {} },
      'selection, current results': { kind: 'selection', projection: 'events', filter: { hidePersonal: true }, query: '', excludeHousekeeping: true },
      'selection, a search': { kind: 'selection', projection: 'events', filter: {}, query: 'nmap' },
      activity: { kind: 'activity', projectId: ENG, anchorEventId: anchor, snapshot },
      'source session': { kind: 'session', projectId: ENG, anchorEventId: anchor, snapshot }
    }
    for (const name of PATHS) {
      const plan = await handlers.get('data:resolveExportPlan')!({}, { format: 'bundle', maskOutOfScope: false, subset: requests[name] }) as { ok: boolean; plan: { id: string }; error?: string }
      if (!plan.ok) throw new Error(`${name}: ${JSON.stringify(plan)}`)
      const done = await handlers.get('data:executeExportPlan')!({}, { planId: plan.plan.id }) as { ok: boolean; artifactPath: string }
      if (!done.ok) throw new Error(`${name}: ${JSON.stringify(done)}`)
      bundles.set(name, done.artifactPath)
    }
    closeHttpBodyIndex()
    db.closeDB()
  }, 120_000)
  afterAll(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  // What each path delivers. Whole project, a selection of all rows and a
  // time range that covers them carry every session_start the rows need;
  // a search, the Activity page's current results (housekeeping excluded:
  // event-queries.ts HOUSEKEEPING_SQL counts system.session_start), one
  // activity and one source session carry none, so every row in them cannot
  // be determined (FR-022 for a bundle that lacks the start).
  //   pre-071 rows (20 chained, 3 logged): their session's start has no stamp
  //   the stamped session: start, a command, a logged request
  //   the session without a start: a command, a logged request
  //   the exports' session: start, then each export's seal
  const c = (proven: number, selfDescribed: number, undetermined: number, logged: [number, number, number]): ProvenanceCounts =>
    ({ chained: { proven, selfDescribed, undetermined }, logged: { selfDescribed: logged[0], stamped: logged[1], undetermined: logged[2] } })
  const EXPECTED: Record<ExportPath, ProvenanceCounts> = {
    'whole project': c(4, 20, 1, [4, 1, 1]),
    'time range': c(4, 0, 1, [1, 1, 1]),
    'selection, all rows': c(6, 20, 1, [4, 1, 1]),
    'selection, current results': c(0, 0, 25, [0, 0, 5]),
    'selection, a search': c(0, 0, 4, [0, 0, 0]),
    activity: c(0, 0, 2, [0, 0, 0]),
    'source session': c(0, 0, 2, [0, 0, 0])
  }

  for (const name of PATHS) {
    it(`${name}: both verifiers report the same counts, and the verdict is the hash-only one`, () => {
      const { ts, py } = judge(bundles.get(name)!)
      expect({ category: ts.category, exitCode: ts.exitCode }, ts.problems.join('\n')).toEqual({ category: 'verified', exitCode: 0 })
      expect(ts.provenance).toEqual(EXPECTED[name])
      if (py) {
        expect(py.status, py.out).toBe(0)
        expect(pythonProvenance(py.out)).toEqual(ts.provenance)
      }
    })
  }

  python.it('the block as printed, for a whole bundle and for one without its session starts', () => {
    const block = (name: ExportPath): string[] => pythonProvenanceBlock(judge(bundles.get(name)!).py!.out)
    expect(block('whole project')).toEqual([
      'Receiver stamp   : events.jsonl: 4 proven, 20 self-described, 1 cannot be determined',
      '                   events_logged.jsonl: 4 self-described (1 stamped, not protected row by row), 1 cannot be determined',
      '                   proven: the row and its session\'s session_start both carry _ingest, under checked hashes',
      '                   self-described: no stamp, a session_start without one, or a row not hashed one by one',
      '                   cannot be determined: the bundle holds no session_start of that session (an export of selected rows can leave it out)',
      '                   these counts do not change the verdict or the exit code'
    ])
    expect(block('selection, current results')).toEqual([
      'Receiver stamp   : events.jsonl: 0 proven, 0 self-described, 25 cannot be determined',
      '                   events_logged.jsonl: 0 self-described, 5 cannot be determined',
      '                   proven: the row and its session\'s session_start both carry _ingest, under checked hashes',
      '                   cannot be determined: the bundle holds no session_start of that session (an export of selected rows can leave it out)',
      '                   these counts do not change the verdict or the exit code'
    ])
  })

  // The counts are not a check. A stamp changed on a chained row breaks the
  // chain at that row, as any change does, and then nothing is counted.
  it('a stamp changed on a chained row breaks the chain in both verifiers, and no counts are reported', () => {
    const dir = copyBundle(bundles.get('whole project')!)
    const file = path.join(dir, 'events.jsonl')
    const list = lines(file)
    const i = list.findIndex((l) => { const d = JSON.parse(String(JSON.parse(l).data)); return d.subtype === 'command_start' && d._ingest?.door === 'legacy-api' })
    const row = JSON.parse(list[i]) as { id: string; data: string }
    const data = JSON.parse(row.data) as { _ingest: Record<string, unknown> }
    data._ingest.door = 'in-process'
    list[i] = JSON.stringify({ ...row, data: JSON.stringify(data) })
    fs.writeFileSync(file, list.join('\n') + '\n')
    const { ts, py } = judge(dir)
    expect(ts.problems).toContain(`CHAIN BROKEN at event ${row.id}: hash mismatch`)
    expect({ category: ts.category, exitCode: ts.exitCode, provenance: ts.provenance }).toEqual({ category: 'failed', exitCode: 1, provenance: null })
    if (py) {
      expect(py.status).toBe(1)
      expect(py.out).toContain(`CHAIN BROKEN at event ${row.id}: hash mismatch`)
      expect(pythonProvenance(py.out)).toBeNull()
    }
  })

  // A logged row's stamp has no per-row protection (FR-024). Added to an old
  // logged row of a whole bundle, it is caught by the logged digest; the row
  // counts as stamped and self-described, never proven.
  it('a stamp added to a logged row fails the logged digest in both verifiers, and the row is not counted proven', () => {
    const dir = copyBundle(bundles.get('whole project')!)
    const file = path.join(dir, 'events_logged.jsonl')
    const list = lines(file)
    const i = list.findIndex((l) => !('_ingest' in JSON.parse(String(JSON.parse(l).data))))
    const row = JSON.parse(list[i]) as { data: string }
    list[i] = JSON.stringify({ ...row, data: JSON.stringify({ ...JSON.parse(row.data), _ingest: { v: 1, door: 'in-process', producer: 'in-process', auth: 'in-process' } }) })
    fs.writeFileSync(file, list.join('\n') + '\n')
    const { ts, py } = judge(dir)
    expect(ts.problems).toContain('logged tier differs from its recorded digest')
    expect({ category: ts.category, exitCode: ts.exitCode }).toEqual({ category: 'failed', exitCode: 1 })
    expect(ts.provenance).toEqual(c(4, 20, 1, [4, 2, 1]))
    if (py) {
      expect(py.status).toBe(1)
      expect(py.out).toContain('FAILED           : logged tier differs from its recorded digest')
      expect(pythonProvenance(py.out)).toEqual(ts.provenance)
    }
  })
})
