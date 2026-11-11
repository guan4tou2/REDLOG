import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { iterateSnapshotEvents } from '../src/core/export-selection'
import { takeExportSnapshot } from '../src/core/export-plan'
import type { IpcContext } from '../src/main/ipc/types'

// A sparse selection used to walk every page of the approved snapshot on the
// main thread, with no await in between: the longer the project, the longer the
// window stayed frozen, however few events were selected. The bound is a ratio
// against the cost of that very scan on this machine, so a slow or loaded
// runner scales both sides of the comparison together.
const ROWS = Number(process.env.REDLOG_STALL_ROWS ?? 30_000)

let dir: string
let handlers: Map<string, (_event: unknown, input?: any) => any>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-stall-'))
  initDB(dir)
  const project = { id: 'eng-1', name: 'stall', path: dir, createdAt: 1, lastOpened: 1 }
  handlers = new Map()
  registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as never,
    { getActiveProject: () => project, getMainWindow: () => null, getCurrentEngagementId: () => project.id } as IpcContext)
  const insert = getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at)
    VALUES (?,?,'eng-1','s','op','shell','command_end','','','example.test',?,?)`)
  getDB().transaction(() => {
    for (let n = 0; n < ROWS; n++) insert.run(`event-${n}`, 10_000 + n, JSON.stringify({ subtype: 'command_end', command: `cmd-${n}`, stdout: 'x'.repeat(200) }), n)
  })()
}, 120_000)
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

it('a sparse selection does not hold the main thread for the length of a full snapshot scan', async () => {
  const middle = 10_000 + Math.floor(ROWS / 2)
  const resolved = await handlers.get('data:resolveExportPlan')!({}, { format: 'json', maskOutOfScope: false, subset: { kind: 'time-range', since: middle, before: middle + 9 } })
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
  expect(resolved.plan.counts.included).toBe(10)

  // What the old path did on the main thread, timed here warm (best of two).
  const snapshot = takeExportSnapshot()
  let scanMs = Infinity
  for (let pass = 0; pass < 2; pass++) {
    const scanStart = performance.now()
    let scanned = 0
    for (const _ of iterateSnapshotEvents(snapshot)) scanned++
    scanMs = Math.min(scanMs, performance.now() - scanStart)
    expect(scanned).toBe(ROWS)
  }
  // Below this the ratio says nothing: the fixture is too small for the machine.
  expect(scanMs).toBeGreaterThan(100)

  let previous = performance.now(), longestStall = 0
  const sample = setInterval(() => {
    const now = performance.now()
    longestStall = Math.max(longestStall, now - previous - 2)
    previous = now
  }, 2)
  let executed: any
  try { executed = await handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id }) }
  finally { clearInterval(sample) }
  expect(executed.ok, JSON.stringify(executed)).toBe(true)
  expect(JSON.parse(fs.readFileSync(executed.artifactPath, 'utf8')).events).toHaveLength(10)
  console.log(`export-main-thread-stall rows=${ROWS} scanMs=${Math.round(scanMs)} longestStallMs=${Math.round(longestStall)}`)
  expect(longestStall).toBeLessThan(scanMs * 0.3)
}, 120_000)
