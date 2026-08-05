import { describe, it, expect } from 'vitest'
import { diffProcs, parsePsLine } from '../src/main/services/process-monitor'

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the process-monitor pid-diff algorithm + ps line parser.
// These are pure functions — no fs / no ps shell-out — so they run fast on
// every platform including CI. Actual `runPs()` behaviour is exercised
// implicitly on macOS/Linux at app start-time.
// ─────────────────────────────────────────────────────────────────────────────

describe('process-monitor / parsePsLine', () => {
  it('parses a normal ps -eo line', () => {
    const row = parsePsLine('12345 12000 01:23 /usr/bin/node --experimental-vm-modules server.js')
    expect(row).not.toBeNull()
    expect(row!.pid).toBe(12345)
    expect(row!.ppid).toBe(12000)
    expect(row!.etime).toBe('01:23')
    expect(row!.command).toBe('/usr/bin/node --experimental-vm-modules server.js')
  })

  it('preserves multi-word commands with args', () => {
    const row = parsePsLine('1 0 10-01:00:00 /sbin/launchd --foo bar baz')
    expect(row?.command).toBe('/sbin/launchd --foo bar baz')
    expect(row?.etime).toBe('10-01:00:00')
  })

  it('returns null on blank lines and headers', () => {
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('   ')).toBeNull()
    expect(parsePsLine('PID PPID ELAPSED COMMAND')).toBeNull()  // header — 'ELAPSED' not numeric
  })

  it('tolerates whitespace in etime', () => {
    const row = parsePsLine('42 1 12-03:04:05 whatever')
    expect(row?.pid).toBe(42)
  })
})

describe('process-monitor / diffProcs', () => {
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, etime: '0:01', command })
  const tracked = (pid: number, ppid: number, command: string) => ({ pid, ppid, command, startedAt: Date.now() - 1000 })

  it('reports new pids as spawns', () => {
    const prev = new Map<number, ReturnType<typeof tracked>>([[10, tracked(10, 1, 'shell')]])
    const next = new Map<number, ReturnType<typeof row>>([
      [10, row(10, 1, 'shell')],
      [11, row(11, 10, 'sleep 5')],
    ])
    const { spawns, exits } = diffProcs(prev, next, [])
    expect(spawns.map((s) => s.pid)).toEqual([11])
    expect(exits).toEqual([])
  })

  it('reports missing pids as exits', () => {
    const prev = new Map([
      [10, tracked(10, 1, 'shell')],
      [11, tracked(11, 10, 'sleep 5')],
    ])
    const next = new Map<number, ReturnType<typeof row>>([[10, row(10, 1, 'shell')]])
    const { spawns, exits } = diffProcs(prev, next, [])
    expect(spawns).toEqual([])
    expect(exits.map((e) => e.pid)).toEqual([11])
  })

  it('ignores commands matching a leading-token ignore', () => {
    const prev = new Map<number, ReturnType<typeof tracked>>()
    const next = new Map([
      [11, row(11, 1, 'ps -eo pid,ppid,etime,command')],
      [12, row(12, 1, 'Electron --type=renderer')],
      [13, row(13, 1, 'redlog Helper (GPU)')],
      [14, row(14, 1, '/usr/bin/git status')],
    ])
    const { spawns } = diffProcs(prev, next, [])
    expect(spawns.map((s) => s.pid)).toEqual([14])
  })

  it('respects operator-supplied ignoreCommands', () => {
    const prev = new Map<number, ReturnType<typeof tracked>>()
    const next = new Map([
      [11, row(11, 1, 'cargo build --release')],
      [12, row(12, 1, 'node target-tool.js')],
    ])
    const { spawns } = diffProcs(prev, next, ['cargo'])
    expect(spawns.map((s) => s.pid)).toEqual([12])
  })

  it('handles pid reuse: same pid, different command counts as one', () => {
    // If a pid was ours in the previous poll and the current poll shows the
    // same pid with a completely different command, that's a race we can't
    // catch at 500ms cadence — the diff-by-pid-existence conservatively
    // reports it as still-running. This test locks in that behaviour so a
    // future change doesn't silently start emitting spawn/exit pairs for
    // every long-running pid on the box.
    const prev = new Map([[10, tracked(10, 1, 'old-cmd')]])
    const next = new Map([[10, row(10, 1, 'new-cmd')]])
    const { spawns, exits } = diffProcs(prev, next, [])
    expect(spawns).toEqual([])
    expect(exits).toEqual([])
  })

  it('returns both spawns and exits in a single diff', () => {
    const prev = new Map([
      [10, tracked(10, 1, 'shell')],
      [11, tracked(11, 10, 'sleep 5')],
    ])
    const next = new Map([
      [10, row(10, 1, 'shell')],
      [12, row(12, 10, 'ls')],
    ])
    const { spawns, exits } = diffProcs(prev, next, [])
    expect(spawns.map((s) => s.pid)).toEqual([12])
    expect(exits.map((e) => e.pid)).toEqual([11])
  })
})
