import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { ManagedHttpProxy } from '../src/main/services/managed-http-proxy'
import { unsavedGapForProject, type UnsavedGap } from '../src/core/unsaved-gap'

// #507: the addon's spool write raced the app's drain, and a gap it could not
// write was only recognised by the app for one reason in four.

function run<T>(mode: string, env: Record<string, string> = {}): T {
  const result = spawnSync('python3', ['test/fixtures/mitm-spool-integrity-check.py', mode],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } })
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

  it('keeps every record written inside one tick of the clock, in the order written', () => {
    const r = run<{ written: boolean; kept: number[]; leftovers: string[] }>('tick')
    expect(r.written).toBe(true)
    expect(r.kept).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(r.leftovers).toEqual([])
  })

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

async function runningProxy(): Promise<{ proxy: ManagedHttpProxy; child: FakeChild; gaps: UnsavedGap[]; nonce: string; env: Record<string, string> }> {
  const child = new FakeChild()
  let env: Record<string, string> = {}
  const proxy = new ManagedHttpProxy({
    spawn: vi.fn((_command: string, _args: string[], options: { env: Record<string, string> }) => { env = options.env; return child as never }) as never,
    exists: () => true, fingerprint: () => null, readinessTimeoutMs: 100, probe: async () => true
  })
  const gaps: UnsavedGap[] = []
  proxy.onUnsavedGap((gap) => gaps.push(gap))
  await proxy.start({ addonPath: '/addon.py', port: 6661 })
  return { proxy, child, gaps, nonce: env.REDLOG_PROXY_GAP_NONCE, env }
}

describe('a gap the addon could not save', () => {
  // Seen from the app: the addon's own output, whichever gap it is for.
  const expected: Array<[string, number, number, number]> = [
    ['queue-full', 1, 1_000_000, 1_000_000],
    ['project-switched', 1, 1_005_000, 1_005_000],
    ['proxy-stopped', 7, 1_000_000, 1_002_000],
    ['delivery-interrupted', 3, 1_000_000, 1_002_000],
    ['delivery-unconfirmed', 1, 1_005_000, 1_005_000]
  ]
  const addonLines = (nonce: string): Record<string, string[]> => {
    const lines = run<Record<string, string[]>>('unsaved', { REDLOG_PROXY_GAP_NONCE: nonce })
    return Object.fromEntries(Object.entries(lines).map(([reason, all]) => [reason, all.filter((line) => line.includes('gap not saved'))]))
  }

  it('is given the addon a fresh nonce on each start', async () => {
    const a = await runningProxy()
    const b = await runningProxy()
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(b.nonce).not.toBe(a.nonce)
    a.proxy.stop(); b.proxy.stop()
  })

  it.each(expected)('%s leaves exactly one line, and the app reads its count, reason, window and owner', async (reason, units, startedAt, endedAt) => {
    const { proxy, child, gaps, nonce } = await runningProxy()
    const lines = addonLines(nonce)[reason]
    expect(lines).toHaveLength(1)
    child.stdout.emit('data', Buffer.from(`[10:00:00.000] ${lines[0]}\n`))
    expect(gaps).toEqual([{ units, reason, startedAt, endedAt, engagementId: 'A' }])
    proxy.stop()
  })

  it('never carries a URL, header or body into the line', async () => {
    expect(JSON.stringify(addonLines('n'))).not.toMatch(/SECRET|private\.test/)
  })

  it('counts every unsaved gap but a project-switched one against the open project', async () => {
    const { proxy, child, nonce } = await runningProxy()
    const lines = addonLines(nonce)
    for (const [reason] of expected) child.stdout.emit('data', Buffer.from(`${lines[reason][0]}\n`))
    expect(proxy.status().unsavedGapEvents).toBe(1 + 7 + 3 + 1)
    proxy.stop()
  })

  it('is on the Timeline as a gap-unsaved that keeps its reason and its window, in the project that owns it', () => {
    const gap = { units: 7, reason: 'proxy-stopped', startedAt: 1_000_000, endedAt: 1_002_000, engagementId: 'A' }
    const data = unsavedGapForProject(gap, { engagementId: 'A' })
    expect(data).toMatchObject({ subtype: 'capture_gap', reason: 'gap-unsaved', gap_reason: 'proxy-stopped',
      skipped_units: 7, gap_started_at: 1_000_000, gap_ended_at: 1_002_000 })
    expect(data?.capture_delivery).toBeUndefined()
  })

  it('says unknown, not lost, for a delivery that was never confirmed', () => {
    for (const reason of ['delivery-unconfirmed', 'delivery-interrupted']) {
      const gap = { units: 1, reason, startedAt: 5, endedAt: 5, engagementId: 'A' }
      expect(unsavedGapForProject(gap, { engagementId: 'A' })?.capture_delivery).toBe('unknown')
    }
  })

  it('is given to no project but the one it names', () => {
    const gap = { units: 1, reason: 'queue-full', startedAt: 5, endedAt: 5, engagementId: 'A' }
    expect(unsavedGapForProject(gap, { engagementId: 'B' })).toBeNull()
    expect(unsavedGapForProject(gap, null)).toBeNull()
  })
})

// The proxy's output is not only the addon's: mitmproxy echoes what a remote
// server sent it, and a server can send a status line that reads as a gap.
describe('text in the proxy output that only looks like a gap line', () => {
  const body = (over: { units?: string; reason?: string; eng?: string } = {}): string =>
    `capture gap not saved: ${over.units ?? '4242'} event(s) reason=${over.reason ?? 'delivery-unconfirmed'} started=1 ended=2 engagement=${over.eng ?? 'A'}`

  async function feed(hostile: (nonce: string) => string[]): Promise<{ gaps: UnsavedGap[]; unsaved: number | undefined; nonce: string; proxy: ManagedHttpProxy; child: FakeChild }> {
    const { proxy, child, gaps, nonce } = await runningProxy()
    for (const chunk of hostile(nonce)) child.stdout.emit('data', Buffer.from(chunk))
    return { gaps, unsaved: proxy.status().unsavedGapEvents, nonce, proxy, child }
  }

  const corpus: Array<[string, (nonce: string) => string[]]> = [
    ['the status line a server answered with, echoed by mitmproxy',
      () => [` << Cannot parse HTTP response: HTTP/1.1 [redlog] ${body()}\n`]],
    ['the same with no nonce, as the whole line', () => [`[redlog] ${body()}\n`]],
    ['a line with a nonce that is not this start\'s', () => [`[10:00:00.000] [redlog] ${body()} nonce=${'0'.repeat(64)}\n`]],
    ['a line with the nonce of no start at all', () => [`[10:00:00.000] [redlog] ${body()} nonce=\n`]],
    ['a genuine line after other text on the same line',
      (nonce) => [`<< Cannot parse HTTP response: [10:00:00.000] [redlog] ${body()} nonce=${nonce}\n`]],
    ['a genuine line followed by more text', (nonce) => [`[redlog] ${body()} nonce=${nonce} and more\n`]],
    ['a genuine line with a 400-digit count', (nonce) => [`[redlog] ${body({ units: '9'.repeat(400) })} nonce=${nonce}\n`]],
    ['a genuine line with a 9-digit count past the bound', (nonce) => [`[redlog] ${body({ units: '999999999' })} nonce=${nonce}\n`]],
    ['a genuine line with a zero count', (nonce) => [`[redlog] ${body({ units: '0' })} nonce=${nonce}\n`]],
    ['a genuine line with a reason that is not one of the addon\'s', (nonce) => [`[redlog] ${body({ reason: 'gap-unsaved' })} nonce=${nonce}\n`]],
    ['a genuine line with a reason that continues past the list', (nonce) => [`[redlog] ${body({ reason: 'queue-fullX' })} nonce=${nonce}\n`]],
    ['a genuine line with no engagement', (nonce) => [`[redlog] capture gap not saved: 4 event(s) reason=queue-full started=1 ended=2 nonce=${nonce}\n`]],
    ['a genuine line with no window', (nonce) => [`[redlog] capture gap not saved: 4 event(s) reason=queue-full engagement=A nonce=${nonce}\n`]],
    ['a carriage return inside the line', (nonce) => [`junk\r[redlog] ${body()} nonce=${nonce}\n`]],
    ['a genuine line with a carriage return before the nonce', (nonce) => [`[redlog] ${body()}\r nonce=${nonce}\n`]],
    ['a line break inside the line', (nonce) => [`[redlog] ${body()}\n nonce=${nonce}\n`]],
    ['a hostile line split across chunks', () => ['[redlog] capture gap not sa', `ved: 4242 event(s) reason=queue-full started=1 ended=2 engagement=A nonce=${'1'.repeat(64)}\n`]],
    ['the nonce alone on a line', (nonce) => [`${nonce}\n`]]
  ]

  it.each(corpus)('%s is neither a gap nor a count', async (_name, hostile) => {
    const { gaps, unsaved, proxy } = await feed(hostile)
    expect(gaps).toEqual([])
    expect(unsaved).toBeUndefined()
    proxy.stop()
  })

  it('does not put the nonce in the proxy\'s error when the proxy dies after printing it', async () => {
    const child = new FakeChild()
    let nonce = ''
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn((_c: string, _a: string[], o: { env: Record<string, string> }) => { nonce = o.env.REDLOG_PROXY_GAP_NONCE; return child as never }) as never,
      exists: () => true, fingerprint: () => null, readinessTimeoutMs: 100, probe: async () => true
    })
    await proxy.start({ addonPath: '/addon.py', port: 6661 })
    child.stdout.emit('data', Buffer.from(`[redlog] ${body({ eng: 'A' })} nonce=${nonce}\n`))
    child.exitCode = 1
    child.emit('exit', 1, null)
    expect(JSON.stringify(proxy.status())).not.toContain(nonce)
  })

  it('still reads a genuine line, even one split across chunks, after hostile ones', async () => {
    const { gaps, unsaved, nonce, proxy, child } = await feed(() => [` << Cannot parse HTTP response: HTTP/1.1 [redlog] ${body()}\n`])
    expect(gaps).toEqual([])
    const line = `[10:00:00.000] [redlog] ${body({ units: '2', reason: 'queue-full' })} nonce=${nonce}\n`
    child.stdout.emit('data', Buffer.from(line.slice(0, 40)))
    child.stdout.emit('data', Buffer.from(line.slice(40)))
    expect(gaps).toEqual([{ units: 2, reason: 'queue-full', startedAt: 1, endedAt: 2, engagementId: 'A' }])
    expect(unsaved).toBeUndefined()
    expect(proxy.status().unsavedGapEvents).toBe(2)
    proxy.stop()
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
