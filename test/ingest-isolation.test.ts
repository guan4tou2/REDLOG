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

  describe('what ingest remembers per terminal and command', () => {
    // The documented fake AWS key; the loot detector recognises its shape.
    const KEY_A = 'AKIAIOSFODNN7EXAMPLE'
    const SECRET_A = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const KEY_B = 'AKIAIOSFODNN7EXAMPLF'

    const lootRows = (): string[] => {
      const db = dbMod.getReadonlyDB()
      return (db.prepare(`SELECT data FROM events WHERE agent_type = 'loot' UNION ALL SELECT data FROM events_logged WHERE agent_type = 'loot'`).all() as Array<{ data: string }>)
        .map((r) => r.data)
    }
    const output = (p: { op: string }, engagementId: string, terminalId: string, stdout: string) =>
      ingestMod.ingest({ agentType: 'shell', operatorId: p.op, engagementId, data: { subtype: 'session_output', terminalId, source: 'builtin-terminal', stdout } })

    // Output chunks are arbitrary read boundaries, so ingest joins each chunk to
    // the tail of the previous one before scanning. The tail is keyed by
    // terminal id, and the next project's terminal can carry the same id.
    it('does not scan the closed project\'s last output into the next project', () => {
      const a = open('eng-A')
      output(a, 'eng-A', 'T1', `export AWS_ACCESS_KEY_ID=${KEY_A}\nexport AWS_SECRET_ACCESS_KEY=${SECRET_A}\n`)
      expect(lootRows()).toHaveLength(1)
      stopProject()

      const b = open('eng-B')
      output(b, 'eng-B', 'T1', 'ls\nREADME.md\n')
      expect(lootRows()).toEqual([])
    })

    it('control: fresh matching text in the next project still produces a loot row', () => {
      const a = open('eng-A')
      output(a, 'eng-A', 'T1', `export AWS_ACCESS_KEY_ID=${KEY_A}\n`)
      stopProject()

      const b = open('eng-B')
      output(b, 'eng-B', 'T1', `export AWS_ACCESS_KEY_ID=${KEY_B}\n`)
      const rows = lootRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain(KEY_B)
      expect(rows[0]).not.toContain(KEY_A)
    })

    it('still joins chunks inside one project, so a secret split across two is found', () => {
      const a = open('eng-A')
      output(a, 'eng-A', 'T1', 'export AWS_ACCESS_KEY_ID=AKIAIOSFOD')
      expect(lootRows()).toEqual([])
      output(a, 'eng-A', 'T1', 'NN7EXAMPLE\n')
      expect(lootRows()).toHaveLength(1)
    })

    // A session_end clears its terminal's tail, but one that arrives while
    // recording is paused is refused before enrichment, so the tail survives:
    // pause, switch project, resume, same terminal id. The built-in terminal
    // sends its session_end with bypassPause; an external redlog-session
    // (hooks/redlog-session.py) does not, and keeps its id across the switch.
    it('does not leak through a session_end that was refused while paused', () => {
      const a = open('eng-A')
      output(a, 'eng-A', 'T1', `export AWS_ACCESS_KEY_ID=${KEY_A}\n`)
      bus.eventBus.pause()
      const end = ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { subtype: 'session_end', terminalId: 'T1', source: 'external-session' } })
      expect(end.skipped).toBe('paused')
      stopProject()

      const b = open('eng-B')
      bus.eventBus.resume()
      output(b, 'eng-B', 'T1', 'ls\nREADME.md\n')
      expect(lootRows()).toEqual([])
    })

    it('a late-output chunk number seen by the closed project is not a resend in the next', () => {
      const chunk = { subtype: 'command_output', command_id: 'cmd-xproj', seq: 1, late: true, stream: 'stdout', stdout: 'tick\n' }
      const a = open('eng-A')
      expect(ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { ...chunk } }).event).not.toBeNull()
      stopProject()

      const b = open('eng-B')
      const r = ingestMod.ingest({ agentType: 'shell', operatorId: b.op, engagementId: 'eng-B', data: { ...chunk } })
      expect(r.skipped).toBeUndefined()
      expect(r.event).not.toBeNull()
    })

    it('control: a resend inside one project is still recognised', () => {
      const chunk = { subtype: 'command_output', command_id: 'cmd-resend', seq: 1, late: true, stream: 'stdout', stdout: 'tick\n' }
      const a = open('eng-A')
      expect(ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { ...chunk } }).event).not.toBeNull()
      expect(ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { ...chunk } }).skipped).toBe('dedup')
    })

    it('_resetIngest forgets which late chunks were seen', () => {
      const chunk = { subtype: 'command_output', command_id: 'cmd-reset', seq: 1, late: true, stream: 'stdout', stdout: 'tick\n' }
      const a = open('eng-A')
      expect(ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { ...chunk } }).event).not.toBeNull()
      ingestMod._resetIngest()
      expect(ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { ...chunk, stdout: 'tock\n' } }).event).not.toBeNull()
    })

    it('does not file the next project\'s late output under the closed project\'s target', () => {
      const a = open('eng-A')
      const start = ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', targetId: 'host-of-a', data: { subtype: 'command_start', command_id: 'cmd-target', command: 'sleep 9' } })
      expect(start.event?.targetId).toBe('host-of-a')
      stopProject()

      const b = open('eng-B')
      const r = ingestMod.ingest({ agentType: 'shell', operatorId: b.op, engagementId: 'eng-B', data: { subtype: 'command_output', command_id: 'cmd-target', seq: 1, late: true, stream: 'stdout', stdout: 'tick\n' } })
      expect(r.event).not.toBeNull()
      expect(r.event?.targetId).toBeNull()
    })

    it('does not bracket the next project\'s command_end with the closed project\'s cast offset', () => {
      ingestMod.configureIngest({ castProbe: () => ({ castPath: '/cast/T1.cast', offset: 100, truncated: false }) })
      const a = open('eng-A')
      ingestMod.ingest({ agentType: 'shell', operatorId: a.op, engagementId: 'eng-A', data: { subtype: 'command_start', terminalId: 'T1', source: 'builtin-terminal', command: 'whoami' } })
      stopProject()

      ingestMod.configureIngest({ castProbe: () => ({ castPath: '/cast/T1.cast', offset: 900, truncated: false }) })
      const b = open('eng-B')
      const end = ingestMod.ingest({ agentType: 'shell', operatorId: b.op, engagementId: 'eng-B', data: { subtype: 'command_end', terminalId: 'T1', source: 'builtin-terminal', command: 'whoami', exit_code: 0 } })
      expect(end.event?.data.io).toMatchObject({ unbracketed: true })
      expect(end.event?.data.io).not.toHaveProperty('off')
    })
  })
})
