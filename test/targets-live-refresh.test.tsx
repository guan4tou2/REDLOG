// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { createThrottledRead } from '../src/renderer/src/lib/throttledRead'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
type Agg = Array<{ target: string; eventCount: number; firstSeen: number; lastSeen: number }>

const mountPage = (onOpen?: (ts: number, id?: string) => void): void => {
  render(<I18nProvider><FilterProvider><ToastContainer /><TargetView onOpenInTimeline={onOpen} /></FilterProvider></I18nProvider>)
}

// The Targets page held the first render's loader in its live-batch
// subscription, whose scope was still empty, so the first live event turned
// every target unclassified. It also re-ran the whole-project aggregate on
// every batch that carried a target, with no single flight and no ordering,
// and read scope only at mount.
describe('the Targets page while recording', () => {
  let b: TimelineBridge
  let r: Record<string, Record<string, unknown>>
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    b = installTimelineBridge()
    r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps its scope classification across a live batch', async () => {
    r.config = { get: vi.fn(async () => ({ scope: { targets: ['10.0.0.1'], excludeTargets: [] } })), save: async () => true }
    r.events.aggregateTargets = async () => [
      { target: 'a.example', eventCount: 1, firstSeen: T0, lastSeen: T0 },
      { target: '10.0.0.1', eventCount: 1, firstSeen: T0, lastSeen: T0 }
    ]
    mountPage()
    await waitFor(() => expect(screen.queryAllByText('OUT')).toHaveLength(1))
    expect(screen.getAllByText('In scope')).toHaveLength(1)
    await act(async () => { b.emitBatch([makeEvent('l1', T0 + 1, 'shell', { targetId: 'a.example' })]) })
    await act(async () => { vi.advanceTimersByTime(2500) })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryAllByText('OUT')).toHaveLength(1)
    expect(screen.getAllByText('In scope')).toHaveLength(1)
    expect(screen.queryByText('Not set')).toBeNull()
  })

  it('keeps at most one aggregate in flight however many batches arrive', async () => {
    const replies: Array<ReturnType<typeof deferred<Agg>>> = []
    let inFlight = 0
    let maxInFlight = 0
    r.events.aggregateTargets = vi.fn(() => {
      const d = deferred<Agg>()
      replies.push(d)
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      return d.promise.finally(() => { inFlight-- })
    })
    // Without the FilterProvider, whose menus read the same aggregate.
    render(<I18nProvider><TargetView /></I18nProvider>)
    await waitFor(() => expect(replies).toHaveLength(1))
    for (let i = 0; i < 20; i++) {
      await act(async () => { b.emitBatch([makeEvent(`l${i}`, T0 + i, 'shell', { targetId: 'a.example' })]) })
    }
    expect(replies).toHaveLength(1)
    await act(async () => { replies[0].resolve([{ target: 'a.example', eventCount: 1, firstSeen: T0, lastSeen: T0 }]) })
    // One trailing read for everything that arrived meanwhile, not twenty.
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(replies).toHaveLength(2)
    await act(async () => { replies[1].resolve([{ target: 'a.example', eventCount: 21, firstSeen: T0, lastSeen: T0 + 19 }]) })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(replies).toHaveLength(2)
    expect(maxInFlight).toBe(1)
    expect(await screen.findByText(/21 events/)).toBeTruthy()
  })

  it('reclassifies when a batch says scope was recomputed', async () => {
    let scope = { targets: ['10.0.0.1'], excludeTargets: [] as string[] }
    r.config = { get: vi.fn(async () => ({ scope })), save: async () => true }
    r.events.aggregateTargets = async () => [{ target: 'a.example', eventCount: 1, firstSeen: T0, lastSeen: T0 }]
    mountPage()
    await waitFor(() => expect(screen.queryAllByText('OUT')).toHaveLength(1))
    scope = { targets: ['a.example'], excludeTargets: [] }
    await act(async () => {
      b.emitBatch([makeEvent('s1', T0 + 1, 'system', { data: { subtype: 'scope_recomputed' } })])
    })
    await waitFor(() => expect(screen.queryAllByText('OUT')).toHaveLength(0))
    expect(screen.getAllByText('In scope')).toHaveLength(1)
  })

  it('re-reads scope when settings are saved elsewhere', async () => {
    const get = vi.fn(async () => ({ scope: { targets: [], excludeTargets: [] } }))
    r.config = { get, save: async () => true }
    // Without the FilterProvider, which reads config on the same event.
    render(<I18nProvider><TargetView /></I18nProvider>)
    await waitFor(() => expect(get).toHaveBeenCalled())
    const before = get.mock.calls.length
    await act(async () => { window.dispatchEvent(new CustomEvent('redlog:config-saved')) })
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before))
  })

  it('says so, and does not mark the target active, when the write fails', async () => {
    r.events.aggregateTargets = async () => [{ target: 'a.example', eventCount: 1, firstSeen: T0, lastSeen: T0 }]
    const set = vi.fn(async () => ({ ok: false, target: null }))
    r.targetContext = { get: async () => null, set, onChange: () => () => {} }
    mountPage()
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1))
    fireEvent.click(screen.getAllByRole('option')[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Work on this' }))
    await screen.findByText('Could not switch the working target')
    expect(set).toHaveBeenCalledWith('a.example')
    expect(screen.queryByText('Working now')).toBeNull()

    set.mockRejectedValueOnce(new Error('ipc'))
    fireEvent.click(screen.getByRole('button', { name: 'Work on this' }))
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByText('Could not switch the working target').length).toBeGreaterThan(0)
    expect(screen.queryByText('Working now')).toBeNull()
  })

  it('passes the newest evidence row to the Timeline when the target is open', async () => {
    r.events.aggregateTargets = async () => [{ target: '10.0.0.5', eventCount: 2, firstSeen: T0 - 10, lastSeen: T0 }]
    b.queryPage.mockResolvedValue(page([
      makeEvent('ev-new', T0, 'shell', { targetId: '10.0.0.5' }),
      makeEvent('ev-old', T0 - 10, 'shell', { targetId: '10.0.0.5' })
    ]))
    const onOpen = vi.fn()
    mountPage(onOpen)
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1))
    fireEvent.click(screen.getAllByRole('option')[0])
    await screen.findByText(/cmd ev-new/)
    fireEvent.keyDown(list, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(T0, 'ev-new'))
  })
})

describe('a throttled, single-flight read', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('drops a reply older than one already applied', async () => {
    const replies: Array<ReturnType<typeof deferred<string>>> = []
    const applied: string[] = []
    const read = createThrottledRead({
      read: () => { const d = deferred<string>(); replies.push(d); return d.promise },
      apply: (v) => applied.push(v),
      fail: () => {},
      minIntervalMs: 2000
    })
    read.now()
    read.now()
    expect(replies).toHaveLength(2)
    replies[1].resolve('new')
    await vi.runAllTimersAsync()
    replies[0].resolve('old')
    await vi.runAllTimersAsync()
    expect(applied).toEqual(['new'])
  })

  it('coalesces requests into one trailing read, no sooner than the interval', async () => {
    let calls = 0
    const read = createThrottledRead({ read: async () => { calls++; return calls }, apply: () => {}, fail: () => {}, minIntervalMs: 2000 })
    read.request()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 10; i++) read.request()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1989)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(2)
  })

  it('applies nothing once disposed', async () => {
    const d = deferred<number>()
    const applied: number[] = []
    const read = createThrottledRead({ read: () => d.promise, apply: (v) => applied.push(v), fail: () => {}, minIntervalMs: 2000 })
    read.now()
    read.dispose()
    d.resolve(1)
    await vi.runAllTimersAsync()
    expect(applied).toEqual([])
  })
})
