import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// socket-attribution joins a traffic event to the command that owns its pid,
// from maps that live as long as the process. A pid is an OS number, not a
// project's: after a switch the next project's traffic can arrive on the same
// pid, and it must not cite a command_start that is a row of the project that
// closed. These run through the real db, ingest and socket-attribution modules.
// Refs #489.

let dbMod: typeof import('../src/core/db/index')
let ingestMod: typeof import('../src/core/ingest')
let ops: typeof import('../src/core/db/operators')
let sock: typeof import('../src/core/socket-attribution')
let bodyIndex: typeof import('../src/core/http-body-index')
let bus: typeof import('../src/core/event-bus')
let dbAvailable = false
try {
  dbMod = await import('../src/core/db/index')
  ingestMod = await import('../src/core/ingest')
  ops = await import('../src/core/db/operators')
  sock = await import('../src/core/socket-attribution')
  bodyIndex = await import('../src/core/http-body-index')
  bus = await import('../src/core/event-bus')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('socket attribution does not outlive its project', () => {
  const dirs: string[] = []
  const PID = 4242
  const PORT = 54321

  /** What the main process does to open a project. */
  const open = (engagementId: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-sock-${engagementId}-`))
    dirs.push(dir)
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(engagementId)
    return ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
  }

  /** What stopProject does to the database (src/main/index.ts closeDB). */
  const stopProject = (): void => { bodyIndex.closeHttpBodyIndex(); dbMod.closeDB() }

  const commandStart = (op: string, engagementId: string, pid: number): string => {
    const r = ingestMod.ingest({
      agentType: 'shell', operatorId: op, engagementId,
      data: { subtype: 'command_start', command: 'sqlmap -u http://t/', terminal_id: 't1', pid }
    })
    return r.event!.id
  }

  const traffic = (op: string, engagementId: string, data: Record<string, unknown>) =>
    ingestMod.ingest({
      agentType: 'scanner', operatorId: op, engagementId,
      data: { subtype: 'connection', host: '10.0.0.5', ...data }
    })

  beforeEach(() => { bus.eventBus.resume() })
  afterEach(() => {
    try { bodyIndex.closeHttpBodyIndex() } catch { /* */ }
    try { dbMod.closeDB() } catch { /* */ }
    ingestMod._resetIngest()
    sock._resetSocketAttribution()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('traffic on a pid the closed project ran a command on gets no cause in the next project', () => {
    const a = open('eng-A')
    const cmdA = commandStart(a, 'eng-A', PID)
    stopProject()

    const b = open('eng-B')
    const r = traffic(b, 'eng-B', { pid: PID })
    expect(r.event).not.toBeNull()
    expect(r.event!.data._causes ?? []).not.toContain(cmdA)
    expect(r.event!.data._causes ?? []).toEqual([])
  })

  it('the port, ancestry and counters of the closed project are gone too', () => {
    const a = open('eng-A')
    const cmdA = commandStart(a, 'eng-A', 500)
    sock.noteProcessParent(PID, 500)
    sock.notePortPid(PORT, PID)
    expect(traffic(a, 'eng-A', { pid: PID }).event!.data._causes).toEqual([cmdA])
    expect(traffic(a, 'eng-A', { source_addr: `127.0.0.1:${PORT}` }).event!.data._causes).toEqual([cmdA])
    expect(sock.attributionStats()).toEqual({ attempted: 2, resolved: 2 })
    stopProject()

    // Counters read zero before the next project has produced anything.
    expect(sock.attributionStats()).toEqual({ attempted: 0, resolved: 0 })

    const b = open('eng-B')
    expect(sock.resolveByPid(PID)).toBeNull()
    expect(sock.resolveByLocalPort(PORT)).toBeNull()
    const r = traffic(b, 'eng-B', { source_addr: `127.0.0.1:${PORT}` })
    expect(r.event!.data._causes ?? []).toEqual([])
    expect(sock.attributionStats()).toEqual({ attempted: 1, resolved: 0 })
  })

  it('control: inside one project the same pid still resolves to its own command', () => {
    const a = open('eng-A')
    const cmdA = commandStart(a, 'eng-A', PID)
    const r = traffic(a, 'eng-A', { pid: PID })
    expect(r.event!.data._causes).toEqual([cmdA])
    expect(sock.attributionStats()).toEqual({ attempted: 1, resolved: 1 })
  })

  it('control: the next project attributes its own command on the reused pid', () => {
    const a = open('eng-A')
    commandStart(a, 'eng-A', PID)
    stopProject()

    const b = open('eng-B')
    const cmdB = commandStart(b, 'eng-B', PID)
    const r = traffic(b, 'eng-B', { pid: PID })
    expect(r.event!.data._causes).toEqual([cmdB])
    expect(sock.attributionStats()).toEqual({ attempted: 1, resolved: 1 })
  })
})
