import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireCaptureHealth, getCaptureHealth, listenCaptureHealth, refreshCaptureHealth, _resetCaptureHealth
} from '../src/renderer/src/lib/captureHealthStore'

// One snapshot, shared. Every reader of capture health used to poll for
// itself, and the readers disagreed about what a failed read meant: two kept
// the last verdict as though it were current, one threw it away. The store
// answers once — a failed read is "unknown", never the last verdict.

const snap = (verdict: string, tag = ''): CaptureHealthInfo =>
  ({ verdict, sources: [], tag, checkedAt: 0 } as unknown as CaptureHealthInfo)

interface Deferred { resolve: (v: unknown) => void; reject: (e: unknown) => void }
let calls: Deferred[]
let health: ReturnType<typeof vi.fn>

/** Let a settled promise's continuation run. */
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-03T22:40:00'))
  _resetCaptureHealth()
  calls = []
  health = vi.fn(() => new Promise((resolve, reject) => { calls.push({ resolve, reject }) }))
  ;(globalThis as unknown as { window: unknown }).window = { redlog: { capture: { health } } }
})
afterEach(() => { _resetCaptureHealth(); vi.useRealTimers() })

describe('capture health store', () => {
  it('starts with nothing read and nothing failed', () => {
    expect(getCaptureHealth()).toMatchObject({ health: null, lastOkAt: null, status: 'ok' })
  })

  it('reads once for any number of subscribers that arrive together', async () => {
    const off = [acquireCaptureHealth(5_000), acquireCaptureHealth(30_000), acquireCaptureHealth(0)]
    expect(health).toHaveBeenCalledTimes(1)
    calls[0].resolve(snap('healthy'))
    await flush()
    expect(getCaptureHealth().health?.verdict).toBe('healthy')
    expect(health).toHaveBeenCalledTimes(1)
    off.forEach((f) => f())
  })

  it('never has two reads in flight: a poll tick during a slow read is dropped', async () => {
    const off = acquireCaptureHealth(1_000)
    await vi.advanceTimersByTimeAsync(1_900)   // under the stall limit, so the read is still the one in flight
    expect(health).toHaveBeenCalledTimes(1)
    off()
  })

  it('a refresh during a read is answered by one follow-up read, after the first returns', async () => {
    const off = acquireCaptureHealth(0)
    refreshCaptureHealth(); refreshCaptureHealth(); refreshCaptureHealth()
    expect(health).toHaveBeenCalledTimes(1)
    calls[0].resolve(snap('healthy', 'before-the-change'))
    await flush()
    // The first read may predate whatever the refresh was asked for.
    expect(health).toHaveBeenCalledTimes(2)
    calls[1].resolve(snap('healthy', 'after-the-change'))
    await flush()
    expect((getCaptureHealth().health as unknown as { tag: string }).tag).toBe('after-the-change')
    off()
  })

  it('records when the last successful read happened', async () => {
    const off = acquireCaptureHealth(0)
    calls[0].resolve(snap('healthy'))
    await flush()
    expect(getCaptureHealth()).toMatchObject({ status: 'ok', lastOkAt: new Date('2026-11-03T22:40:00').getTime() })
    off()
  })

  it('a failed read is unknown, keeps the last snapshot as history, and does not move lastOkAt', async () => {
    const off = acquireCaptureHealth(30_000)
    calls[0].resolve(snap('healthy'))
    await flush()
    const okAt = getCaptureHealth().lastOkAt
    await vi.advanceTimersByTimeAsync(30_000)
    calls[1].reject(new Error('ipc closed'))
    await flush()
    expect(getCaptureHealth()).toMatchObject({ status: 'unknown', lastOkAt: okAt })
    expect(getCaptureHealth().health?.verdict).toBe('healthy')
    off()
  })

  it('treats a reply that is not a snapshot as a failed read', async () => {
    const off = acquireCaptureHealth(0)
    calls[0].resolve(null)
    await flush()
    expect(getCaptureHealth()).toMatchObject({ status: 'unknown', health: null, lastOkAt: null })
    off()
  })

  it('recovers on the next successful read', async () => {
    const off = acquireCaptureHealth(5_000)
    calls[0].reject(new Error('boom'))
    await flush()
    expect(getCaptureHealth().status).toBe('unknown')
    await vi.advanceTimersByTimeAsync(5_000)
    calls[1].resolve(snap('partial'))
    await flush()
    expect(getCaptureHealth()).toMatchObject({ status: 'ok' })
    expect(getCaptureHealth().health?.verdict).toBe('partial')
    off()
  })

  it('applies responses in order: a slow older read never overwrites a newer one', async () => {
    // The route to two reads outstanding at once: every reader leaves, the
    // read is abandoned, and the next reader starts its own.
    const first = acquireCaptureHealth(0)
    first()
    const second = acquireCaptureHealth(0)
    expect(health).toHaveBeenCalledTimes(2)
    calls[1].resolve(snap('dark', 'newer'))
    await flush()
    calls[0].resolve(snap('healthy', 'older'))
    await flush()
    expect((getCaptureHealth().health as unknown as { tag: string }).tag).toBe('newer')
    second()
  })

  it('a slow older failure does not turn a newer success into unknown', async () => {
    const first = acquireCaptureHealth(0)
    first()
    const second = acquireCaptureHealth(0)
    calls[1].resolve(snap('healthy'))
    await flush()
    calls[0].reject(new Error('late'))
    await flush()
    expect(getCaptureHealth().status).toBe('ok')
    second()
  })

  it('polls at the fastest interval any mounted subscriber asks for', async () => {
    const slow = acquireCaptureHealth(30_000)
    calls[0].resolve(snap('healthy')); await flush()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(health).toHaveBeenCalledTimes(0)

    const fast = acquireCaptureHealth(5_000)
    // arriving is itself a read
    expect(health).toHaveBeenCalledTimes(1)
    calls[1].resolve(snap('healthy')); await flush()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(health).toHaveBeenCalledTimes(1)
    calls[2].resolve(snap('healthy')); await flush()

    // Fast one leaves: back to the slow cadence.
    fast()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(health).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(health).toHaveBeenCalledTimes(1)
    slow()
  })

  it('a subscriber that does not poll adds no timer of its own', async () => {
    const off = acquireCaptureHealth(0)
    calls[0].resolve(snap('healthy')); await flush()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(health).not.toHaveBeenCalled()
    off()
  })

  it('stops reading when the last subscriber leaves', async () => {
    const a = acquireCaptureHealth(5_000)
    const b = acquireCaptureHealth(5_000)
    calls[0].resolve(snap('healthy')); await flush()
    a()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(health).toHaveBeenCalledTimes(1)
    calls[1].resolve(snap('healthy')); await flush()
    b()
    health.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(health).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('a read that never settles', () => {
    it('is unknown after twice the poll interval, keeps what was last confirmed, and the next tick reads again', async () => {
      const off = acquireCaptureHealth(5_000)
      calls[0].resolve(snap('healthy', 'confirmed')); await flush()
      const okAt = getCaptureHealth().lastOkAt
      await vi.advanceTimersByTimeAsync(5_000)            // tick: read #2 starts and never settles
      expect(health).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)            // one interval in: still not a verdict either way
      expect(getCaptureHealth().status).toBe('ok')
      expect(health).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)            // twice the interval
      expect(getCaptureHealth()).toMatchObject({ status: 'unknown', lastOkAt: okAt })
      expect((getCaptureHealth().health as unknown as { tag: string }).tag).toBe('confirmed')
      await vi.advanceTimersByTimeAsync(5_000)            // the next tick is a new read
      expect(health).toHaveBeenCalledTimes(3)
      calls[2].resolve(snap('partial')); await flush()
      expect(getCaptureHealth()).toMatchObject({ status: 'ok' })
      expect(getCaptureHealth().health?.verdict).toBe('partial')
      off()
    })

    it('the abandoned read settling later is dropped, whether it succeeds or fails, and does not move the status', async () => {
      const off = acquireCaptureHealth(5_000)
      await vi.advanceTimersByTimeAsync(10_000)           // read #1 abandoned
      expect(getCaptureHealth().status).toBe('unknown')
      await vi.advanceTimersByTimeAsync(5_000)            // read #2 in flight
      const n = health.mock.calls.length
      expect(n).toBe(2)
      calls[0].resolve(snap('healthy', 'abandoned')); await flush()
      expect(getCaptureHealth()).toMatchObject({ status: 'unknown', health: null })
      calls[1].resolve(snap('dark', 'current')); await flush()
      expect((getCaptureHealth().health as unknown as { tag: string }).tag).toBe('current')
      calls[0].reject(new Error('late')); await flush()
      expect(getCaptureHealth().status).toBe('ok')
      off()
    })

    it('a slow read that finishes inside twice the interval is not reported as unknown', async () => {
      const off = acquireCaptureHealth(5_000)
      await vi.advanceTimersByTimeAsync(9_000)
      expect(getCaptureHealth().status).toBe('ok')
      calls[0].resolve(snap('healthy')); await flush()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getCaptureHealth().status).toBe('ok')
      expect(getCaptureHealth().health?.verdict).toBe('healthy')
      off()
    })

    it('is also called unknown for a reader that does not poll, after the fallback wait', async () => {
      const off = acquireCaptureHealth(0)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(getCaptureHealth().status).toBe('ok')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(getCaptureHealth().status).toBe('unknown')
      off()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('a refresh with nobody listening reads nothing', () => {
    refreshCaptureHealth()
    expect(health).not.toHaveBeenCalled()
  })

  it('tells listeners when the state changes, and only then', async () => {
    const seen: string[] = []
    const stop = listenCaptureHealth(() => seen.push(getCaptureHealth().status))
    const off = acquireCaptureHealth(0)
    calls[0].reject(new Error('x'))
    await flush()
    expect(seen).toEqual(['unknown'])
    off(); stop()
  })
})
