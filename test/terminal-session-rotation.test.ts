import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const fake = vi.hoisted(() => ({ panes: [] as Array<{ pid: number; emit: (text: string) => void; exit: (code: number) => void; kill: ReturnType<typeof vi.fn> }> }))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => {
  let data: (text: string) => void = () => {}
  let exit: (value: { exitCode: number }) => void = () => {}
  const pane = { pid: 1000 + fake.panes.length, emit: (text: string) => data(text), exit: (code: number) => exit({ exitCode: code }), kill: vi.fn(), write: vi.fn(), resize: vi.fn(), onData: (fn: typeof data) => { data = fn }, onExit: (fn: typeof exit) => { exit = fn } }
  fake.panes.push(pane)
  return pane
}) }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../src/core/cast-index', () => ({ indexCast: vi.fn(async () => undefined) }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { configureIngest, ingestEvent, _resetIngest } from '../src/core/ingest'
import { resetCausesResolver } from '../src/core/causes-resolver'
import { eventBus } from '../src/core/event-bus'
import { verifyChainFullAsync } from '../src/core/chain-anchor'
import { ensurePrimaryOperator, generateToken } from '../src/core/db/operators'
import { getCaptureHealth } from '../src/core/capture-health'
import { readTerminalEnrollment, writeTerminalEnrollment } from '../src/core/terminal-enrollment'
import { configureTerminal, detachTerminalRecordings, resumeTerminalRecordings, spawnTerminal, killAllTerminals, getCastPosition, listTerminals, recoverOrphanSessions } from '../src/main/terminal-manager'

let root: string
let homeSpy: ReturnType<typeof vi.spyOn>
function open(name: string, cap = 50000): string {
  const dir = path.join(root, name)
  initDB(dir)
  ensurePrimaryOperator('operator', 'Operator', generateToken())
  configureTerminal({ engagementId: name, projectId: name, operatorId: 'operator', maxCastBytes: cap })
  configureIngest({ castProbe: getCastPosition })
  return dir
}
function rows(): Array<{ id: string; data: Record<string, any> }> {
  return (getDB().prepare('SELECT id, data FROM events ORDER BY rowid').all() as Array<{ id: string; data: string }>).map(row => ({ ...row, data: JSON.parse(row.data) }))
}
function command(subtype: string, id: string): ReturnType<typeof ingestEvent> {
  return ingestEvent('shell', { source: 'builtin-terminal', terminalId: 'pane', subtype, command_id: id, command: `echo ${id}`, pid: 1000, exit_code: 0,
    ...(subtype === 'command_end' ? { completeness: 'full', output_disposition: 'captured', stdout: 'producer buffer spanning A and B' } : {})
  }, { engagementId: current, operatorId: 'operator' })
}
let current = 'A'
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-rotate-'))
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(root)
  fake.panes.length = 0
  current = 'A'
  eventBus.resume('ui')
  _resetIngest()
  open('A')
})
afterEach(() => { killAllTerminals(); closeDB(); _resetIngest(); homeSpy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }) })

describe('project recording rotation without killing the pane', () => {
  it('keeps the PID through picker/B/A; each closed cast and chain owns only its own output', async () => {
    const pid = spawnTerminal('pane', 80, 24).pid
    fake.panes[0].emit('A-only\r\n')
    command('command_start', 'in-flight')
    detachTerminalRecordings()
    const a = rows()
    const aEnd = a.find(row => row.data.subtype === 'session_end')!.data
    expect(aEnd).toMatchObject({ reason: 'project-switched', exitCode: null })
    expect(aEnd.castSha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(aEnd.castPath)).digest('hex'))
    expect(a.some(row => row.data.subtype === 'command_boundary' && row.data._causes?.includes(a.find(row => row.data.subtype === 'command_start')!.id))).toBe(true)
    expect((await verifyChainFullAsync()).ok).toBe(true)
    closeDB(); resetCausesResolver()
    fake.panes[0].emit('picker-never-recorded\r\n')
    expect(listTerminals()[0]).toMatchObject({ pid, recording: false, recordingReason: 'no-project' })
    current = 'B'; open('B'); resumeTerminalRecordings()
    fake.panes[0].emit('B-only\r\n')
    const completion = command('command_end', 'in-flight')!
    expect(completion.data.boundary_from).toMatchObject({ projectId: 'A', recordingId: aEnd.recordingId, commandId: 'in-flight' })
    expect(completion.data._causes).toBeUndefined()
    expect(completion.data.stdout).toBeUndefined()
    expect(completion.data.completeness).toBe('partial')
    expect(completion.data.output_disposition).toBe('project-boundary')
    expect(completion.data.io).toMatchObject({ ref: getCastPosition('pane')!.castPath, unbracketed: true })
    detachTerminalRecordings()
    const b = rows()
    const bEnd = b.find(row => row.data.subtype === 'session_end')!.data
    expect(fs.readFileSync(bEnd.castPath, 'utf8')).toContain('B-only')
    expect(fs.readFileSync(bEnd.castPath, 'utf8')).not.toMatch(/A-only|picker-never-recorded/)
    expect(JSON.stringify(b)).not.toContain(aEnd.castPath)
    expect((await verifyChainFullAsync()).ok).toBe(true)
    closeDB(); resetCausesResolver()
    current = 'A'; open('A')
    expect(recoverOrphanSessions()).toBe(0)
    resumeTerminalRecordings()
    fake.panes[0].emit('A-return-only\r\n')
    expect(spawnTerminal('pane', 80, 24).pid).toBe(pid)
    expect(fake.panes[0].kill).not.toHaveBeenCalled()
    expect(rows().filter(row => row.data.subtype === 'session_start')).toHaveLength(2)
    const latest = rows().filter(row => row.data.subtype === 'session_start')[1].data
    expect(latest.continues).toMatchObject({ projectId: 'B', recordingId: bEnd.recordingId })
    expect(latest.recordingId).not.toBe(aEnd.recordingId)
  })

  it('keeps a failed new recording persistently visible without weakening the old close', () => {
    spawnTerminal('pane', 80, 24)
    fake.panes[0].emit('old-final-bytes')
    detachTerminalRecordings()
    expect(rows().find(row => row.data.subtype === 'session_end')!.data.castSha256).toMatch(/^[a-f0-9]{64}$/)
    closeDB(); resetCausesResolver()
    current = 'B'; const dir = open('B')
    fs.writeFileSync(path.join(dir, 'casts'), 'not a directory')
    resumeTerminalRecordings()
    expect(listTerminals()[0]).toMatchObject({ recording: false, recordingReason: 'recording-failed' })
    fake.panes[0].emit('still usable')
    expect(command('command_start', 'must-not-claim-recorded')).toBeNull()
    expect(rows().some(row => row.data.command === 'echo must-not-claim-recorded')).toBe(false)
    expect(getCaptureHealth(Date.now() + 11 * 60 * 1000).sources.find(source => source.id === 'terminal')!.state).toBe('error')
    expect(fake.panes[0].kill).not.toHaveBeenCalled()
  })

  it('completes a paused outgoing binding, starts a fresh budget, and finalizes once on actual exit', () => {
    spawnTerminal('pane', 80, 24)
    eventBus.pause('ui')
    detachTerminalRecordings()
    expect(rows().filter(row => row.data.subtype === 'session_end')).toHaveLength(1)
    closeDB(); resetCausesResolver()
    current = 'B'; open('B', 350); eventBus.resume('ui'); resumeTerminalRecordings()
    fake.panes[0].emit('x'.repeat(2000))
    expect(listTerminals()[0].castTruncated).toBe(true)
    detachTerminalRecordings(); closeDB(); resetCausesResolver()
    current = 'C'; open('C'); resumeTerminalRecordings()
    expect(listTerminals()[0]).toMatchObject({ recording: true, castTruncated: false })
    fake.panes[0].exit(7)
    killAllTerminals()
    expect(rows().filter(row => row.data.subtype === 'session_end')).toHaveLength(1)
    expect(rows().find(row => row.data.subtype === 'session_end')!.data).toMatchObject({ reason: 'shell-exited', exitCode: 7 })
  })

  it('rotates ten panes without waiting for their running commands', () => {
    for (let n = 0; n < 10; n++) {
      spawnTerminal(`pane-${n}`, 80, 24)
      ingestEvent('shell', { source: 'builtin-terminal', terminalId: `pane-${n}`, subtype: 'command_start', command: 'sleep 99', command_id: `busy-${n}` }, { engagementId: 'A', operatorId: 'operator' })
    }
    const started = performance.now()
    expect(detachTerminalRecordings()).toBe(10)
    closeDB(); resetCausesResolver(); current = 'B'; open('B')
    expect(resumeTerminalRecordings()).toBe(10)
    // A rotation that waited would wait for `sleep 99`. Five seconds still
    // tells that apart, where one second failed on a loaded Windows runner
    // (1205 ms) while the rotation itself did nothing wrong.
    expect(performance.now() - started).toBeLessThan(5000)
    expect(listTerminals()).toHaveLength(10)
    expect(fake.panes.every(pane => pane.kill.mock.calls.length === 0)).toBe(true)
    expect(rows().filter(row => row.data.subtype === 'session_start').every(row => row.data.rotationPaneCount === 10)).toBe(true)
  })

  it('recovers each orphan once by its local start, even when the same pane had completed segments', () => {
    spawnTerminal('pane', 80, 24); detachTerminalRecordings()
    const orphan = ingestEvent('shell', { subtype: 'session_start', source: 'builtin-terminal', terminalId: 'pane', recordingId: 'orphan-segment' }, { engagementId: 'A', operatorId: 'operator' })!
    configureTerminal({ engagementId: 'A', projectId: 'A', operatorId: 'operator' })
    expect(recoverOrphanSessions()).toBe(1)
    expect(rows().find(row => row.data.reason === 'recovered-orphan')!.data._causes).toEqual([orphan.id])
    expect(recoverOrphanSessions()).toBe(0)
  })

  it('honors a pane stop for raw cast bytes and preserves that choice across project rotation', () => {
    spawnTerminal('pane', 80, 24)
    const state = readTerminalEnrollment(root, 'pane')!
    writeTerminalEnrollment(root, { ...state, recording: false, stoppedReason: 'operator' })
    fake.panes[0].emit('private-while-stopped')
    expect(listTerminals()[0]).toMatchObject({ recording: false, paused: true })
    detachTerminalRecordings()
    const old = rows().find(row => row.data.subtype === 'session_end')!.data
    expect(fs.readFileSync(old.castPath, 'utf8')).not.toContain('private-while-stopped')
    closeDB(); resetCausesResolver(); current = 'B'; open('B'); resumeTerminalRecordings()
    fake.panes[0].emit('still-private-after-switch')
    expect(listTerminals()[0]).toMatchObject({ recording: false, paused: true })
    const next = readTerminalEnrollment(root, 'pane')!
    writeTerminalEnrollment(root, { ...next, recording: true, stoppedReason: undefined })
    fake.panes[0].emit('recording-resumed')
    detachTerminalRecordings()
    const end = rows().find(row => row.data.subtype === 'session_end')!.data
    expect(fs.readFileSync(end.castPath, 'utf8')).not.toContain('still-private-after-switch')
    expect(fs.readFileSync(end.castPath, 'utf8')).toContain('recording-resumed')
  })
})
