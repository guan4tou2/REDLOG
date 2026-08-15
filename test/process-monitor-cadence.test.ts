// processMonitor.pollMs — the poll cadence, and the platform floors that stop a
// too-eager setting from stacking `ps` calls on top of each other.
//
// Previously manual-only (G-UI1) on the assumption that this needed a live
// poller. It does not: the schedule is decided synchronously in
// `startProcessMonitor`, so spying the timer is enough — and the Windows floor
// in particular is exactly the kind of platform-conditional constant that never
// gets exercised on the maintainer's machine.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('child_process', () => ({
  // Answer the seed scan with no processes; the cadence is what is under test.
  execFile: (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, '')
}))
vi.mock('../src/core/db/events', () => ({ insertEvent: () => null }))

const { startProcessMonitor, stopProcessMonitor } = await import('../src/main/services/process-monitor')

const ATTRIBUTION = { enabled: true, engagementId: 'e', operatorId: 'op' }

/** Platform is read at schedule time, so it can be swapped per test. */
function asPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
const REAL_PLATFORM = process.platform

/** The interval `startProcessMonitor` schedules, in ms — null if it declined.
 *
 *  `pollMs: undefined` is passed explicitly because the monitor merges a partial
 *  over module-level config: without it, a `pollMs` set by an earlier test leaks
 *  into the next one and "the default" silently becomes "whatever ran before". */
function scheduled(opts: Record<string, unknown> = {}): number | null {
  const spy = vi.spyOn(globalThis, 'setInterval')
  startProcessMonitor({ ...ATTRIBUTION, pollMs: undefined, ...opts })
  const call = spy.mock.calls[spy.mock.calls.length - 1]
  spy.mockRestore()
  return call ? (call[1] as number) : null
}

beforeEach(() => stopProcessMonitor())
afterEach(() => {
  stopProcessMonitor()
  asPlatform(REAL_PLATFORM)
  vi.restoreAllMocks()
})

describe('pollMs on macOS / Linux', () => {
  beforeEach(() => asPlatform('darwin'))

  it('defaults to 500 ms', () => {
    expect(scheduled({})).toBe(500)
  })

  it('honours a slower cadence verbatim', () => {
    expect(scheduled({ pollMs: 5000 })).toBe(5000)
  })

  it('honours a faster one down to the 200 ms floor', () => {
    expect(scheduled({ pollMs: 250 })).toBe(250)
    expect(scheduled({ pollMs: 200 })).toBe(200)
  })

  it('floors anything below 200 ms — polling faster than `ps` returns just queues work', () => {
    expect(scheduled({ pollMs: 10 })).toBe(200)
    // 0 is a real value here (`??` only fills in null/undefined), so it lands on
    // the floor rather than on the default.
    expect(scheduled({ pollMs: 0 })).toBe(200)
  })

  it('linux behaves like darwin', () => {
    asPlatform('linux')
    expect(scheduled({})).toBe(500)
    expect(scheduled({ pollMs: 50 })).toBe(200)
  })
})

describe('pollMs on Windows', () => {
  beforeEach(() => asPlatform('win32'))

  it('defaults to 2000 ms — a cold PowerShell spawn is 800-1500 ms', () => {
    expect(scheduled({})).toBe(2000)
  })

  it('floors at 2000 ms, so the 500 ms cross-platform default cannot stack calls', () => {
    expect(scheduled({ pollMs: 500 })).toBe(2000)
    expect(scheduled({ pollMs: 100 })).toBe(2000)
  })

  it('a deliberately slower cadence is still honoured', () => {
    expect(scheduled({ pollMs: 10_000 })).toBe(10_000)
  })
})

describe('when the monitor declines to run at all', () => {
  beforeEach(() => asPlatform('darwin'))

  it('disabled (the default) schedules nothing', () => {
    expect(scheduled({ enabled: false })).toBeNull()
  })

  it('no engagement id — every event needs attribution', () => {
    expect(scheduled({ engagementId: '' })).toBeNull()
  })

  it('no operator id', () => {
    expect(scheduled({ operatorId: '' })).toBeNull()
  })

  it('an unsupported platform is skipped rather than half-started', () => {
    asPlatform('freebsd')
    expect(scheduled({})).toBeNull()
  })
})

describe('restart semantics', () => {
  beforeEach(() => asPlatform('darwin'))

  it('starting again replaces the timer instead of stacking a second poller', () => {
    startProcessMonitor({ ...ATTRIBUTION, pollMs: 500 })
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const set = vi.spyOn(globalThis, 'setInterval')
    startProcessMonitor({ ...ATTRIBUTION, pollMs: 1500 })
    expect(clear).toHaveBeenCalled()
    expect(set.mock.calls[set.mock.calls.length - 1][1]).toBe(1500)
  })

  it('stop clears the timer and is idempotent', () => {
    startProcessMonitor({ ...ATTRIBUTION })
    const clear = vi.spyOn(globalThis, 'clearInterval')
    stopProcessMonitor()
    stopProcessMonitor()
    expect(clear).toHaveBeenCalled()
  })
})
