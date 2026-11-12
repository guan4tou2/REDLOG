import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { createThrottledRead } from '../src/renderer/src/lib/throttledRead'

// The one pacing helper behind Targets, the dashboard's live card and the
// shared app counts. Each option one of those callers relies on is pinned
// here; targets-live-refresh.test.tsx covers the reply-ordering half.

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('request(): leading, interval-paced trailing, single flight', () => {
  it('runs at once when idle, then folds a burst into one trailing run after the interval', async () => {
    let calls = 0
    const r = createThrottledRead({ read: async () => { calls++ }, minIntervalMs: 1000 })
    r.request()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 20; i++) r.request()
    await vi.advanceTimersByTimeAsync(989)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })

  it('never overlaps a run in flight, and runs once more after it for requests made meanwhile', async () => {
    const d = deferred<void>()
    let calls = 0
    const r = createThrottledRead({ read: () => { calls++; return calls === 1 ? d.promise : Promise.resolve() }, minIntervalMs: 1000 })
    r.request()
    for (let i = 0; i < 5; i++) { r.request(); await vi.advanceTimersByTimeAsync(1000) }
    expect(calls).toBe(1)
    d.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
  })
})

describe('request({ immediate: true })', () => {
  it('skips the interval and cancels a pending interval wait', async () => {
    let calls = 0
    const r = createThrottledRead({ read: async () => { calls++ }, minIntervalMs: 1000 })
    r.request()
    await vi.advanceTimersByTimeAsync(10)
    r.request() // waits for the interval
    r.request({ immediate: true })
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })

  it('still waits for a run in flight, then starts without the interval', async () => {
    const d = deferred<void>()
    let calls = 0
    const r = createThrottledRead({ read: () => { calls++; return calls === 1 ? d.promise : Promise.resolve() }, minIntervalMs: 1000 })
    r.request()
    r.request({ immediate: true })
    expect(calls).toBe(1)
    d.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
  })
})

describe('replies and failures', () => {
  it('delivers a rejection, and a synchronous throw, to fail()', async () => {
    const failed: unknown[] = []
    let n = 0
    const r = createThrottledRead<number>({
      read: () => { n++; if (n === 1) return Promise.reject(new Error('a')); throw new Error('b') },
      apply: () => {},
      fail: (e) => failed.push((e as Error).message),
      minIntervalMs: 0
    })
    r.now()
    await vi.advanceTimersByTimeAsync(0)
    r.now()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toEqual(['a', 'b'])
  })

  it('without apply/fail, swallows a rejection and keeps pacing; a non-promise read works', async () => {
    let calls = 0
    const r = createThrottledRead({ read: () => { calls++; if (calls === 1) return Promise.reject(new Error('x')); return undefined }, minIntervalMs: 100 })
    r.request()
    await vi.advanceTimersByTimeAsync(0)
    r.request()
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
    r.request()
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(3)
  })

  it('after dispose, applies nothing and starts no trailing run', async () => {
    const d = deferred<number>()
    const applied: number[] = []
    let calls = 0
    const r = createThrottledRead({ read: () => { calls++; return d.promise }, apply: (v) => applied.push(v), minIntervalMs: 100 })
    r.request()
    r.request({ immediate: true })
    r.dispose()
    d.resolve(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(applied).toEqual([])
    expect(calls).toBe(1)
  })
})
