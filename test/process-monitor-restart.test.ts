import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The process monitor (src/main/services/process-monitor.ts) against a scripted
// process table and fake time. Both of its asynchronous `ps` runs, the seed a
// restart takes and each poll, can finish after the monitor was restarted or
// turned off, and config:save and project open configure it twice in one
// synchronous run. A run that finishes late must not act: no repeated "ps is
// unusable" advisory, no replacing a newer seed, and nothing recorded once
// capture is off. The table is printed the way the platform's own ps prints
// it, so the real parsers run on every platform.

interface Proc { pid: number; ppid: number; command: string }

const h = vi.hoisted(() => ({
  table: [] as Array<{ pid: number; ppid: number; command: string }>,
  /** How long the next ps run takes, read when it starts. */
  delay: 5,
  /** Make ps fail, as BusyBox's does on the procps flags. */
  fail: false,
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('child_process', () => ({
  // The table as it is when ps starts, delivered when it finishes.
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const stdout = h.table
      .map((p) => (process.platform === 'win32' ? `${p.pid}|${p.ppid}|${p.command}` : `${p.pid} ${p.ppid} 00:10 ${p.command}`))
      .join('\n')
    const fail = h.fail
    setTimeout(() => (fail ? cb(new Error('ps: unrecognized option: w'), '') : cb(null, stdout)), h.delay)
  }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_agentType: string, data: Record<string, unknown>, ids: { operatorId?: string }) => {
    h.rows.push({ ...data, operatorId: ids.operatorId })
    return null
  }
}))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))

let pm: typeof import('../src/main/services/process-monitor')

const IDS = { engagementId: 'eng', operatorId: 'op' }
const ON = { enabled: true, pollMs: 2000, ignoreCommands: [], ...IDS }
// A parent that is not this process, so none of these counts as RedLog's own.
const a: Proc = { pid: 424201, ppid: 424200, command: '/usr/bin/nmap -sV 10.0.0.5' }
const b: Proc = { pid: 424202, ppid: 424200, command: '/usr/bin/python3 -m http.server 8000' }
const c: Proc = { pid: 424203, ppid: 424200, command: '/usr/bin/ssh -D 1080 jump.example' }

const advisories = (): Array<Record<string, unknown>> => h.rows.filter((r) => r.subtype === 'process_monitor_ps_unavailable')
const spawns = (): Array<Record<string, unknown>> => h.rows.filter((r) => r.subtype === 'process_spawn')
// config:save in src/main/index.ts: the options, then applyCapturePacks.
const save = (packOn: boolean): void => {
  pm.configureProcessMonitor({ pollMs: 2000, ignoreCommands: [], ...IDS })
  pm.configureProcessMonitor({ enabled: packOn })
}
/** Let the ps runs in flight finish (one takes 5 ms unless told otherwise). */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(10)

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.table = []
  h.delay = 5
  h.fail = false
  h.rows.length = 0
  pm = await import('../src/main/services/process-monitor')
})

afterEach(() => {
  pm.stopProcessMonitor()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('process monitor — saying ps is unusable once per capture start', () => {
  beforeEach(() => { h.fail = true })

  it('says it when capture starts', async () => {
    pm.configureProcessMonitor(ON)
    await settle()
    expect(advisories()).toHaveLength(1)
  })

  it('does not say it again for a Settings save while capture stays on', async () => {
    pm.configureProcessMonitor(ON)
    await settle()
    save(true)
    await settle()
    expect(advisories()).toHaveLength(1)
  })

  it('does not say it for the save that turns the pack off', async () => {
    pm.configureProcessMonitor(ON)
    await settle()
    save(false)
    await settle()
    expect(advisories()).toHaveLength(1)
  })

  it('says it again when the pack is turned back on', async () => {
    pm.configureProcessMonitor(ON)
    await settle()
    save(false)
    await settle()
    save(true)
    await settle()
    expect(advisories()).toHaveLength(2)
  })

  it('says it once in the new project after a project switch', async () => {
    pm.configureProcessMonitor(ON)
    await settle()
    // stopProject, then startProject: configure, then applyCapturePacks.
    pm.stopProcessMonitor()
    pm.configureProcessMonitor({ pollMs: 2000, ignoreCommands: [], engagementId: 'eng2', operatorId: 'op2' })
    pm.configureProcessMonitor({ enabled: true })
    await settle()
    expect(advisories().map((r) => r.operatorId)).toEqual(['op', 'op2'])
  })
})

describe('process monitor — a ps run that finishes late', () => {
  it('records nothing when the pack was turned off while a poll was running ps', async () => {
    h.table = [a]
    pm.configureProcessMonitor(ON)
    await settle()                              // seeded: a was already running
    h.table = [a, c]
    h.delay = 50
    await vi.advanceTimersByTimeAsync(1990)     // t=2000: the first poll runs ps
    save(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(spawns()).toHaveLength(0)
  })

  it('records nothing when the monitor was stopped while a poll was running ps', async () => {
    h.table = [a]
    pm.configureProcessMonitor(ON)
    await settle()
    h.table = [a, c]
    h.delay = 50
    await vi.advanceTimersByTimeAsync(1990)
    pm.stopProcessMonitor()                     // project close
    await vi.advanceTimersByTimeAsync(100)
    expect(spawns()).toHaveLength(0)
  })

  it('does not replay running processes as spawns when a save restarts it mid-poll', async () => {
    h.table = [a, b]
    pm.configureProcessMonitor(ON)
    await settle()                              // seeded: both already running
    h.delay = 50
    await vi.advanceTimersByTimeAsync(1990)     // a poll is running ps
    save(true)                                  // the restart empties what is known
    await vi.advanceTimersByTimeAsync(100)
    expect(spawns()).toHaveLength(0)
  })

  it('does not let a slower, older seed replace the newer one', async () => {
    h.table = [a]
    h.delay = 100
    pm.configureProcessMonitor(ON)              // t=0: seed reads [a], lands at t=100
    await vi.advanceTimersByTimeAsync(10)
    h.table = [a, c]
    h.delay = 5
    save(true)                                  // t=10: seed reads [a, c], lands at t=15
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(2000)     // the first poll after the save reads [a, c]
    expect(spawns(), 'c predates the newest seed').toHaveLength(0)
  })

  it('still records a process that starts after the seed', async () => {
    h.table = [a]
    pm.configureProcessMonitor(ON)
    await settle()
    h.table = [a, c]
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawns().map((r) => r.pid)).toEqual([c.pid])
  })
})
