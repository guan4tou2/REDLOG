import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Two projects share one process, and ingest() is the one door both write
// through. These pin what a project may not take from the one before it:
// a refused foreign row has no side effects in the open project, and nothing
// ingest remembers per terminal or command outlives the database it was read
// from. Refs #488.

let dbMod: typeof import('../src/core/db/index')
let ingestMod: typeof import('../src/core/ingest')
let ops: typeof import('../src/core/db/operators')
let bodies: typeof import('../src/core/http-body-store')
let bodyIndex: typeof import('../src/core/http-body-index')
let causes: typeof import('../src/core/causes-resolver')
let lootMod: typeof import('../src/core/loot-detector')
let bus: typeof import('../src/core/event-bus')
let dbAvailable = false
try {
  dbMod = await import('../src/core/db/index')
  ingestMod = await import('../src/core/ingest')
  ops = await import('../src/core/db/operators')
  bodies = await import('../src/core/http-body-store')
  bodyIndex = await import('../src/core/http-body-index')
  causes = await import('../src/core/causes-resolver')
  lootMod = await import('../src/core/loot-detector')
  bus = await import('../src/core/event-bus')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('ingest keeps one project from reaching the next', () => {
  const dirs: string[] = []
  let loot: InstanceType<typeof import('../src/core/loot-detector').LootDetector>
  let current: { dir: string; op: string } | null = null
  let errors: ReturnType<typeof vi.spyOn>

  /** What the main process does to open a project: a database, bound to its
   *  engagement, with the loot detector pointed at it. */
  const open = (engagementId: string): { dir: string; op: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-ingest-iso-${engagementId}-`))
    dirs.push(dir)
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(engagementId)
    bodies.resetBodiesDirCache()
    const op = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
    loot.configure({ identity: { projectId: engagementId, engagementId, operatorId: op } })
    ingestMod.configureIngest({ lootDetector: loot })
    current = { dir, op }
    return current
  }

  /** What stopProject does that ingest can see (src/main/index.ts): the
   *  database closes, the causes resolver is reset, activeTarget is cleared.
   *  Nothing here touches ingest's own maps. */
  const stopProject = (): void => {
    bodyIndex.closeHttpBodyIndex()
    dbMod.closeDB()
    causes.resetCausesResolver()
    ingestMod.configureIngest({ activeTarget: null })
    bodies.resetBodiesDirCache()
    current = null
  }

  beforeEach(() => {
    bus.eventBus.resume()
    loot = new lootMod.LootDetector()
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errors.mockRestore()
    bus.eventBus.resume()
    try { bodyIndex.closeHttpBodyIndex() } catch { /* */ }
    try { dbMod.closeDB() } catch { /* */ }
    ingestMod._resetIngest()
    bodies.resetBodiesDirCache()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    current = null
  })

  const rowCount = (): number => {
    const db = dbMod.getReadonlyDB()
    return (db.prepare('SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM events_logged) AS n').get() as { n: number }).n
  }
  const bodyFiles = (): string[] => {
    try { return fs.readdirSync(path.join(current!.dir, 'http-bodies')) } catch { return [] }
  }

  describe('a row for another engagement', () => {
    // Over the 4 KiB inline threshold, so the body goes to a file.
    const httpResponse = (host: string, marker: string) => {
      const big = `${marker} `.repeat(1000)
      return {
        subtype: 'http_response', host, url: `https://${host}/`, flow_id: `flow-${host}`, status: 200,
        response_body: { data: big, encoding: 'text', size: big.length, sha256: '' }
      }
    }

    it('writes no body file into the open project, and reports it as it always did', () => {
      const p = open('eng-B')
      const r = ingestMod.ingest({ agentType: 'scanner', operatorId: p.op, engagementId: 'eng-A', data: httpResponse('a.example', 'SECRET-OF-A') })
      expect(r.event).toBeNull()
      expect(r.skipped).toBe('dedup')
      expect(r.companions).toEqual([])
      expect(bodyFiles()).toEqual([])
      expect(rowCount()).toBe(0)
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('eng-A'))
    })

    it('control: the same event for the bound engagement writes one row and one file', () => {
      const p = open('eng-B')
      const r = ingestMod.ingest({ agentType: 'scanner', operatorId: p.op, engagementId: 'eng-B', data: httpResponse('b.example', 'BODY-OF-B') })
      expect(r.event).not.toBeNull()
      expect(r.skipped).toBeUndefined()
      expect(bodyFiles()).toHaveLength(1)
      expect(rowCount()).toBe(1)
      expect(errors).not.toHaveBeenCalled()
    })
  })
})
