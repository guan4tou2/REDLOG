// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { createLiveTotal, type LiveTotal } from '../src/renderer/src/lib/liveTotal'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const status = (): string => screen.getByTestId('timeline-range-status').textContent ?? ''

// "N of M" while recording: a live row admitted while the count was in flight
// re-issued the count when its reply landed. When counting takes longer than
// the gap between admitted rows — a 200k-row project during a scan — every
// reply found a newer row, the count was chained back-to-back for as long as
// anything was recording, and M stayed "…" the whole time.
describe('the Timeline total under continuous admission', () => {
  let b: TimelineBridge
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('settles on a number, and stops counting, while rows keep arriving', async () => {
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page([makeEvent('e1', T0)], true, 'c1'))
    const replies: Array<ReturnType<typeof deferred<number>>> = []
    b.count.mockImplementation(() => { const d = deferred<number>(); replies.push(d); return d.promise })
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(replies.length).toBe(1))

    // Every count is overtaken by an admitted row before it replies.
    let n = 0
    for (let round = 0; round < 6; round++) {
      await act(async () => { b.emitBatch([makeEvent(`live-${n++}`, T0 + n)]) })
      await waitFor(() => expect(b.matchIds).toHaveBeenCalledTimes(n))
      const pending = replies.filter((_, i) => i >= round)
      await act(async () => { for (const r of pending) r.resolve(100 + round) })
      await act(async () => { vi.advanceTimersByTime(2500) })
    }

    expect(status()).not.toContain('…')
    expect(status()).toMatch(/of \d+ events/)
    // The first count, and at most one more after a quiet period.
    expect(b.count.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('recounts without asking for the span again, and keeps M on screen while it does', async () => {
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page([makeEvent('e1', T0)], true, 'c1'))
    const replies: Array<ReturnType<typeof deferred<number>>> = []
    b.count.mockImplementation(() => { const d = deferred<number>(); replies.push(d); return d.promise })
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(replies.length).toBe(1))
    await waitFor(() => expect(b.span).toHaveBeenCalledTimes(1))
    await act(async () => { b.emitBatch([makeEvent('live-1', T0 + 1)]) })
    await waitFor(() => expect(b.matchIds).toHaveBeenCalledTimes(1))
    await act(async () => { replies[0].resolve(40) })
    await waitFor(() => expect(status()).toMatch(/of 41 events/))
    await act(async () => { vi.advanceTimersByTime(2500) })
    await waitFor(() => expect(replies.length).toBe(2))
    expect(status()).toMatch(/of 41 events/)
    await act(async () => { replies[1].resolve(41) })
    expect(status()).toMatch(/of 41 events/)
    expect(b.span).toHaveBeenCalledTimes(1)
  })
})

describe('the live total, alone', () => {
  const setup = (): { lt: LiveTotal; published: unknown[]; replies: Array<ReturnType<typeof deferred<number>>> } => {
    const replies: Array<ReturnType<typeof deferred<number>>> = []
    const published: unknown[] = []
    const lt = createLiveTotal({
      count: () => { const d = deferred<number>(); replies.push(d); return d.promise },
      publish: (t) => published.push(t),
      recountDelayMs: 2000
    })
    return { lt, published, replies }
  }
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is exact when nothing was admitted while it counted', async () => {
    const { lt, published, replies } = setup()
    lt.request()
    expect(published.at(-1)).toEqual({ state: 'pending' })
    replies[0].resolve(10)
    await vi.runAllTimersAsync()
    expect(published.at(-1)).toEqual({ state: 'ok', value: 10 })
    lt.admitted(3)
    expect(published.at(-1)).toEqual({ state: 'ok', value: 13 })
    expect(replies).toHaveLength(1)
  })

  it('never shows fewer than were drawn, counts once more after a pause, then stops', async () => {
    const { lt, published, replies } = setup()
    lt.request()
    lt.admitted(2)
    replies[0].resolve(10)
    await Promise.resolve(); await Promise.resolve()
    // 10 or 12 — the count may or may not include the two. It says 12, the
    // bound that keeps N ≤ M, and is no longer pending.
    expect(published.at(-1)).toEqual({ state: 'ok', value: 12 })
    expect(replies).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(replies).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(replies).toHaveLength(2)
    // The recount keeps showing the last value, rows still add to it.
    lt.admitted(1)
    expect(published.at(-1)).toEqual({ state: 'ok', value: 13 })
    replies[1].resolve(20)
    await vi.runAllTimersAsync()
    expect(published.at(-1)).toEqual({ state: 'ok', value: 21 })
    // Overtaken twice: accepted, and no third count.
    expect(replies).toHaveLength(2)
  })

  it('a recount that comes back clean is taken as it is', async () => {
    const { lt, published, replies } = setup()
    lt.request(); lt.admitted(1)
    replies[0].resolve(10)
    await vi.advanceTimersByTimeAsync(2000)
    replies[1].resolve(11)
    await vi.runAllTimersAsync()
    expect(published.at(-1)).toEqual({ state: 'ok', value: 11 })
  })

  it('publishes nothing once disposed', async () => {
    const { lt, published, replies } = setup()
    lt.request(); lt.admitted(1)
    lt.dispose()
    const before = published.length
    replies[0].resolve(10)
    await vi.runAllTimersAsync()
    expect(published.length).toBe(before)
    expect(replies).toHaveLength(1)
  })

  it('keeps the last value when a recount fails, and says failed when there was none', async () => {
    const { lt, published, replies } = setup()
    lt.request()
    replies[0].reject(new Error('locked'))
    await vi.runAllTimersAsync()
    expect(published.at(-1)).toEqual({ state: 'failed' })
    lt.request(); lt.admitted(1)
    replies[1].resolve(5)
    await vi.advanceTimersByTimeAsync(2000)
    replies[2].reject(new Error('locked'))
    await vi.runAllTimersAsync()
    expect(published.at(-1)).toEqual({ state: 'ok', value: 6 })
  })
})
