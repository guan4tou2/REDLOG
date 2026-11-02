import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { ManagedHttpProxy } from '../src/main/services/managed-http-proxy'
import { unsavedGapEventData, type UnsavedGap } from '../src/core/unsaved-gap'

// #507: the addon's spool write raced the app's drain, and a gap it could not
// write was only recognised by the app for one reason in four.

function run<T>(mode: string): T {
  const result = spawnSync('python3', ['test/fixtures/mitm-spool-integrity-check.py', mode], { encoding: 'utf8', timeout: 60000 })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as T
}

describe('the addon\'s spool write against the app\'s drain', () => {
  it('is not refused as full because the drain removed a file between listing and measuring it', () => {
    const r = run<{ deterministic: { written: boolean; drained: number; json_files: number }; threaded: { writes: number; failed: number } }>('race')
    expect(r.deterministic.drained).toBeGreaterThan(0)
    expect(r.deterministic.written).toBe(true)
    expect(r.deterministic.json_files).toBeGreaterThan(0)
    expect(r.threaded.failed).toBe(0)
  }, 60000)

  it('still refuses a write that would really pass the file or size cap, and writes nothing', () => {
    const r = run<{ count_cap: { written: boolean; unchanged: boolean }; size_cap: { written: boolean; files: string[] } }>('caps')
    expect(r.count_cap).toEqual({ written: false, unchanged: true })
    expect(r.size_cap).toEqual({ written: false, files: ['big.json'] })
  }, 60000)

  it('shows the drain a record only as a complete .json, renamed into place', () => {
    const r = run<{ written: boolean; visible_before_rename: string[]; complete_at_rename: boolean; leftovers: string[]; json_files: number }>('atomic')
    expect(r.written).toBe(true)
    expect(r.visible_before_rename).toEqual([])
    expect(r.complete_at_rename).toBe(true)
    expect(r.leftovers).toEqual([])
    expect(r.json_files).toBe(1)
  })
})

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(): boolean { this.killed = true; this.exitCode = 0; this.emit('exit', 0, null); return true }
}

async function runningProxy(): Promise<{ proxy: ManagedHttpProxy; child: FakeChild; gaps: UnsavedGap[] }> {
  const child = new FakeChild()
  const proxy = new ManagedHttpProxy({ spawn: vi.fn(() => child as never), exists: () => true, fingerprint: () => null,
    readinessTimeoutMs: 100, probe: async () => true })
  const gaps: UnsavedGap[] = []
  proxy.onUnsavedGap((gap) => gaps.push(gap))
  await proxy.start({ addonPath: '/addon.py', port: 6661 })
  return { proxy, child, gaps }
}

describe('a gap the addon could not save', () => {
  const lines = run<Record<string, string[]>>('unsaved')
  const gapLines = (reason: string): string[] => lines[reason].filter((line) => line.includes('gap not saved'))

  // Seen from the app: the addon's own output, whichever gap it is for.
  const expected: Array<[string, number, number, number]> = [
    ['queue-full', 1, 1_000_000, 1_000_000],
    ['project-switched', 1, 1_005_000, 1_005_000],
    ['proxy-stopped', 7, 1_000_000, 1_002_000],
    ['delivery-interrupted', 3, 1_000_000, 1_002_000],
    ['delivery-unconfirmed', 1, 1_005_000, 1_005_000]
  ]

  it.each(expected)('%s leaves exactly one line, and the app reads its count, reason, window and owner', async (reason, units, startedAt, endedAt) => {
    expect(gapLines(reason)).toHaveLength(1)
    const { proxy, child, gaps } = await runningProxy()
    child.stdout.emit('data', Buffer.from(`[10:00:00.000] ${gapLines(reason)[0]}\n`))
    expect(gaps).toEqual([{ units, reason, startedAt, endedAt, engagementId: 'A' }])
    proxy.stop()
  })

  it('never carries a URL, header or body into the line', () => {
    expect(JSON.stringify(lines)).not.toMatch(/SECRET|private\.test/)
  })

  it('counts every unsaved gap but a project-switched one against the open project', async () => {
    const { proxy, child } = await runningProxy()
    for (const [reason] of expected) child.stdout.emit('data', Buffer.from(`${gapLines(reason)[0]}\n`))
    expect(proxy.status().unsavedGapEvents).toBe(1 + 7 + 3 + 1)
    proxy.stop()
  })

  it('is on the Timeline as a gap-unsaved that keeps its reason and its window', () => {
    const data = unsavedGapEventData({ units: 7, reason: 'proxy-stopped', startedAt: 1_000_000, endedAt: 1_002_000, engagementId: 'A' })
    expect(data).toMatchObject({ subtype: 'capture_gap', reason: 'gap-unsaved', gap_reason: 'proxy-stopped',
      skipped_units: 7, gap_started_at: 1_000_000, gap_ended_at: 1_002_000 })
    expect(data.capture_delivery).toBeUndefined()
  })

  it('says unknown, not lost, for a delivery that was never confirmed', () => {
    for (const reason of ['delivery-unconfirmed', 'delivery-interrupted']) {
      expect(unsavedGapEventData({ units: 1, reason, startedAt: 5, endedAt: 5 }).capture_delivery).toBe('unknown')
    }
  })
})

describe('an event refused after the project went away', () => {
  const r = run<Record<string, Array<{ reason: string; identity: unknown; units: number }>>>('cleared')

  it('is not called a project switch when the identity was cleared, not changed', () => {
    expect(r.cleared).toEqual([{ reason: 'proxy-stopped', identity: { engagementId: 'A', operatorId: 'op-A' }, units: 1 }])
  })

  it('is still a project switch when another project is the open one', () => {
    expect(r.switched).toEqual([{ reason: 'project-switched', identity: { engagementId: 'A', operatorId: 'op-A' }, units: 1 }])
  })
})
