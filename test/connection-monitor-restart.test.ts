import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Connection } from '../src/core/connection-table'

// The connection monitor (src/main/services/connection-monitor.ts) against a
// scripted socket table and fake time. Both of its asynchronous reads, the seed
// a restart takes and each poll, can finish after the monitor was restarted or
// turned off, and config:save and project open configure it twice in one
// synchronous run. A read that finishes late must not act: no announcement of
// a capture start that is not one, no replacing a newer seed, and nothing
// recorded once capture is off.

const h = vi.hoisted(() => ({
  table: [] as Connection[],
  /** How long the next socket-table read takes, read when it starts. */
  delay: 5,
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('child_process', () => ({
  // The table as it is when the command runs, delivered when it finishes.
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const stdout = JSON.stringify(h.table)
    setTimeout(() => cb(null, stdout), h.delay)
  }
}))
vi.mock('../src/core/connection-table', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/connection-table')>()
  const parse = (out: string): Connection[] => (out ? (JSON.parse(out) as Connection[]) : [])
  return { ...actual, parseSs: parse, parseNetstatBsd: parse, parseNetstatWin: parse }
})
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (agentType: string, data: Record<string, unknown>, ids: { operatorId?: string }) => {
    h.rows.push({ agentType, ...data, operatorId: ids.operatorId })
    return null
  }
}))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))
vi.mock('../src/core/socket-attribution', () => ({ notePortPid: () => {}, socketCausesFor: () => [] }))

let cm: typeof import('../src/main/services/connection-monitor')

const IDS = { engagementId: 'eng', operatorId: 'op' }
const ON = { enabled: true, pollMs: 1000, selfPorts: [], ...IDS }
const c1: Connection = { proto: 'tcp', localAddr: '10.0.0.5', localPort: 50001, remoteAddr: '203.0.113.9', remotePort: 443, pid: 4242 }
const c2: Connection = { ...c1, localPort: 50002, remoteAddr: '203.0.113.10' }

const announcements = (): Array<Record<string, unknown>> => h.rows.filter((r) => r.subtype === 'connection_capture_started')
const opened = (): Array<Record<string, unknown>> => h.rows.filter((r) => r.subtype === 'connection')
// config:save in src/main/index.ts: the options, then applyCapturePacks.
const save = (packOn: boolean): void => {
  cm.configureConnectionMonitor({ pollMs: 1000, selfPorts: [] })
  cm.configureConnectionMonitor({ enabled: packOn })
}
/** Let the reads in flight finish (one takes 5 ms unless told otherwise). */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(10)

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  h.table = []
  h.delay = 5
  h.rows.length = 0
  cm = await import('../src/main/services/connection-monitor')
})

afterEach(() => {
  cm.stopConnectionMonitor()
  vi.useRealTimers()
})

describe('connection monitor — announcing the blind spot once per capture start', () => {
  it('announces it when capture starts', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    expect(announcements()).toHaveLength(1)
  })

  it('does not announce it again for a Settings save while capture stays on', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    save(true)
    await settle()
    expect(announcements()).toHaveLength(1)
  })

  it('does not announce a start for the save that turns the pack off', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    save(false)
    await settle()
    expect(announcements()).toHaveLength(1)
  })

  it('announces it again when capture is turned back on', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    save(false)
    await settle()
    save(true)
    await settle()
    expect(announcements()).toHaveLength(2)
  })

  it('announces it once in the new project after a project switch', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    // stopProject, then startProject: configure, then applyCapturePacks.
    cm.stopConnectionMonitor()
    cm.configureConnectionMonitor({ pollMs: 1000, selfPorts: [], engagementId: 'eng2', operatorId: 'op2' })
    cm.configureConnectionMonitor({ enabled: true })
    await settle()
    expect(announcements().map((r) => r.operatorId)).toEqual(['op', 'op2'])
  })
})

describe('connection monitor — a read that finishes late', () => {
  it('records nothing when the pack was turned off while a poll was reading', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()                              // seeded: nothing open
    h.table = [c1]
    h.delay = 50
    await vi.advanceTimersByTimeAsync(990)      // t=1000: the first poll starts reading
    save(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(opened()).toHaveLength(0)
  })

  it('records nothing when the monitor was stopped while a poll was reading', async () => {
    cm.configureConnectionMonitor(ON)
    await settle()
    h.table = [c1]
    h.delay = 50
    await vi.advanceTimersByTimeAsync(990)
    cm.stopConnectionMonitor()                  // project close
    await vi.advanceTimersByTimeAsync(100)
    expect(opened()).toHaveLength(0)
  })

  it('does not replay open connections as new when a save restarts it mid-poll', async () => {
    h.table = [c1]
    cm.configureConnectionMonitor(ON)
    await settle()                              // seeded: c1 was already open
    h.delay = 50
    await vi.advanceTimersByTimeAsync(990)      // a poll is reading
    save(true)                                  // the restart resets what is known
    await vi.advanceTimersByTimeAsync(100)
    expect(opened()).toHaveLength(0)
  })

  it('does not let a slower, older seed replace the newer one', async () => {
    h.table = [c1]
    h.delay = 100
    cm.configureConnectionMonitor(ON)           // t=0: seed reads [c1], lands at t=100
    await vi.advanceTimersByTimeAsync(10)
    h.table = [c1, c2]
    h.delay = 5
    save(true)                                  // t=10: seed reads [c1, c2], lands at t=15
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(1000)     // the first poll after the save reads [c1, c2]
    expect(opened(), 'c2 predates the newest seed').toHaveLength(0)
  })
})
