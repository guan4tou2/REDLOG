import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { iterateSnapshotEvents } from '../src/core/export-selection'
import { takeExportSnapshot } from '../src/core/export-plan'
import type { IpcContext } from '../src/main/ipc/types'
import { installWorkCounter, measureWorkAsync, uninstallWorkCounter, type WorkProfile } from './helpers/work-counter'

// A sparse selection (10 events out of N) used to walk every page of the
// approved snapshot on the main thread, with no await in between: the longer
// the project, the longer the window stayed frozen, however few events were
// selected. Since 6f1ff450 selection, redaction and digest run in the export
// worker. This counts the work the MAIN thread does during
// data:executeExportPlan instead of timing it: the counter wraps better-sqlite3
// and JSON.parse on the thread that installed it, and the worker is a separate
// thread with its own module instances, so its reads are not counted here.
// Equal counts at two sizes show the main thread's share does not grow with
// the project.
const SMALL = 3_000
const LARGE = Number(process.env.REDLOG_STALL_ROWS ?? 30_000)

// What main still does during execute, measured at both sizes (see the log
// line): 4 statements that return no rows and parse no JSON. Pinned just above
// that; a snapshot walk returns thousands of rows and parses each one.
const MAX_MAIN_ROWS = 4
const MAX_MAIN_JSON_PARSE = 4

beforeAll(() => installWorkCounter())
afterAll(() => uninstallWorkCounter())

type Handlers = Map<string, (_event: unknown, input?: any) => any>

function seeded(rows: number): { dir: string; handlers: Handlers } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-stall-'))
  initDB(dir)
  const project = { id: 'eng-1', name: 'stall', path: dir, createdAt: 1, lastOpened: 1 }
  const handlers: Handlers = new Map()
  registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as never,
    { getActiveProject: () => project, getMainWindow: () => null, getCurrentEngagementId: () => project.id } as IpcContext)
  const insert = getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at)
    VALUES (?,?,'eng-1','s','op','shell','command_end','','','example.test',?,?)`)
  getDB().transaction(() => {
    for (let n = 0; n < rows; n++) insert.run(`event-${n}`, 10_000 + n, JSON.stringify({ subtype: 'command_end', command: `cmd-${n}`, stdout: 'x'.repeat(200) }), n)
  })()
  return { dir, handlers }
}

/** Resolve the sparse plan, then count what the main thread does to execute it.
 *  `onMain` runs on the main thread inside the measured window. */
async function executeSparse(rows: number, onMain?: () => void): Promise<{ work: WorkProfile; scanStatements: string[] }> {
  const { dir, handlers } = seeded(rows)
  try {
    const middle = 10_000 + Math.floor(rows / 2)
    const resolved = await handlers.get('data:resolveExportPlan')!({}, { format: 'json', maskOutOfScope: false, subset: { kind: 'time-range', since: middle, before: middle + 9 } })
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
    expect(resolved.plan.counts.included).toBe(10)
    const { result: executed, work, scanStatements } = await measureWorkAsync(async () => {
      const pending = handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id })
      onMain?.()
      return pending
    })
    expect(executed.ok, JSON.stringify(executed)).toBe(true)
    expect(JSON.parse(fs.readFileSync(executed.artifactPath, 'utf8')).events).toHaveLength(10)
    return { work, scanStatements }
  } finally { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) }
}

const mainReads = (w: WorkProfile) => ({ statements: w.statements, rows: w.rows, jsonParse: w.jsonParse, scans: w.scans })
const scansOfEvents = (s: string[]) => s.filter((q) => /\bevents(_logged)?\b/.test(q))

it('executing a sparse selection does not read the snapshot on the main thread, at any size', async () => {
  const small = await executeSparse(SMALL)
  const large = await executeSparse(LARGE)
  console.log(`export-main-thread-stall small=${SMALL} ${JSON.stringify(mainReads(small.work))} large=${LARGE} ${JSON.stringify(mainReads(large.work))}`)
  for (const run of [small, large]) {
    expect(run.work.rows).toBeLessThanOrEqual(MAX_MAIN_ROWS)
    expect(run.work.jsonParse).toBeLessThanOrEqual(MAX_MAIN_JSON_PARSE)
    expect(scansOfEvents(run.scanStatements), 'scan over events on main').toEqual([])
  }
  expect(mainReads(large.work)).toEqual(mainReads(small.work))
}, 120_000)

it('the counter sees the old behaviour: a snapshot walk on main during execute', async () => {
  const run = await executeSparse(SMALL, () => {
    let seen = 0
    for (const _ of iterateSnapshotEvents(takeExportSnapshot())) seen++
    expect(seen).toBe(SMALL)
  })
  expect(run.work.rows).toBeGreaterThan(SMALL)
  expect(run.work.jsonParse).toBeGreaterThan(MAX_MAIN_JSON_PARSE)
}, 120_000)
