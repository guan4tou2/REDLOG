// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { mergeKnownAgentTypes, mergeKnownTargets } from '../src/renderer/src/lib/knownLists'
import { installTimelineBridge, makeEvent, type TimelineBridge } from './helpers/timeline-bridge'

let api: ReturnType<typeof useSharedFilter>
function Probe(): null { api = useSharedFilter(); return null }

const T0 = 1_700_000_000_000

// The target and type menus were re-read in full — two scans over both tiers
// — two seconds after every live batch, for as long as anything was recording,
// on every view. The batch already carries what can be new in those lists.
describe('the shared filter menus while recording', () => {
  let b: TimelineBridge
  let aggregateTargets: ReturnType<typeof vi.fn>
  let distinctAgentTypes: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    b = installTimelineBridge()
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    aggregateTargets = vi.fn(async () => [{ target: 'a.example', eventCount: 2, firstSeen: T0 - 9000, lastSeen: T0 - 5000 }])
    distinctAgentTypes = vi.fn(async () => ['shell'])
    events.aggregateTargets = aggregateTargets
    events.distinctAgentTypes = distinctAgentTypes
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps the lists current from the batches themselves, with no full re-read', async () => {
    render(<FilterProvider><Probe /></FilterProvider>)
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    expect(aggregateTargets).toHaveBeenCalledTimes(1)
    expect(distinctAgentTypes).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 30; i++) {
      await act(async () => {
        b.emitBatch([
          makeEvent(`n${i}`, T0 + i, i % 2 ? 'dns' : 'shell', { targetId: i < 15 ? 'b.example' : 'A.EXAMPLE' })
        ])
        vi.advanceTimersByTime(1000)
      })
    }
    await act(async () => { vi.advanceTimersByTime(10_000) })

    expect(aggregateTargets).toHaveBeenCalledTimes(1)
    expect(distinctAgentTypes).toHaveBeenCalledTimes(1)
    // Newest first, as the aggregate orders them; one entry per target in
    // any casing, carrying the most recent casing, as the aggregate groups.
    expect(api.knownTargets.map((x) => [x.target, x.eventCount])).toEqual([['A.EXAMPLE', 17], ['b.example', 15]])
    expect(api.knownAgentTypes).toEqual(['dns', 'shell'])
  })

  it('reads the lists again in full when the window regains focus', async () => {
    render(<FilterProvider><Probe /></FilterProvider>)
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    await act(async () => { vi.advanceTimersByTime(60_000); window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(aggregateTargets).toHaveBeenCalledTimes(2))
    expect(distinctAgentTypes).toHaveBeenCalledTimes(2)
  })

  it('does not lose a target that arrived while a full read was in flight', async () => {
    let release!: (v: unknown) => void
    aggregateTargets.mockImplementationOnce(() => new Promise((r) => { release = r }))
    render(<FilterProvider><Probe /></FilterProvider>)
    await act(async () => { b.emitBatch([makeEvent('late', T0, 'shell', { targetId: 'c.example' })]) })
    // The read had already been taken: it does not know c.example.
    await act(async () => { release([{ target: 'a.example', eventCount: 2, firstSeen: T0 - 9000, lastSeen: T0 - 5000 }]) })
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    expect(api.knownTargets.map((x) => x.target)).toEqual(['c.example', 'a.example'])
  })
})

describe('retrying the menus while a read is in flight', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('starts a new read, and the older reply cannot put the error back', async () => {
    installTimelineBridge()
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    let failFirst!: (e: unknown) => void
    const distinct = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('locked') })
      .mockImplementationOnce(() => new Promise((_, rej) => { failFirst = rej }))
      .mockImplementation(async () => ['shell'])
    events.distinctAgentTypes = distinct
    render(<FilterProvider><Probe /></FilterProvider>)
    await waitFor(() => expect(api.listsStatus).toBe('error'))
    // A focus read is in flight, still answering for the fault.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(distinct).toHaveBeenCalledTimes(2))
    await act(async () => { api.retryLists() })
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    await act(async () => { failFirst(new Error('locked')) })
    expect(api.listsStatus).toBe('ready')
    expect(distinct).toHaveBeenCalledTimes(3)
  })
})

describe('merging a batch into the known lists', () => {
  it('returns the same list when the batch adds nothing', () => {
    const list = [{ target: 'a', eventCount: 1, lastSeen: 5 }]
    expect(mergeKnownTargets(list, [makeEvent('x', 6) as never])).toBe(list)
    const types = ['shell']
    expect(mergeKnownAgentTypes(types, [makeEvent('x', 6) as never])).toBe(types)
  })

  it('adds a missing target without counting a known one again, in presence mode', () => {
    const list = [{ target: 'a', eventCount: 3, lastSeen: 5 }]
    const out = mergeKnownTargets(list, [
      makeEvent('x', 6, 'shell', { targetId: 'A' }) as never,
      makeEvent('y', 7, 'shell', { targetId: 'b' }) as never
    ], 'presence')
    expect(out).toEqual([{ target: 'b', eventCount: 1, lastSeen: 7 }, { target: 'a', eventCount: 3, lastSeen: 5 }])
  })

  it('leaves out the housekeeping rows the aggregate leaves out', () => {
    const list = [{ target: 'a', eventCount: 1, lastSeen: 5 }]
    expect(mergeKnownTargets(list, [
      makeEvent('h1', 6, 'shell', { targetId: 'a', data: { subtype: 'command_start', command: 'source ~/.redlog/Shell-Bash-Hook.sh' } }) as never,
      makeEvent('h2', 7, 'shell', { targetId: 'b', data: { subtype: 'command_output', streamed: true } }) as never,
      makeEvent('h3', 8, 'system', { targetId: 'c', data: { subtype: 'session_start' } }) as never
    ])).toBe(list)
    expect(mergeKnownTargets(list, [
      makeEvent('o', 9, 'shell', { targetId: 'b', data: { subtype: 'command_output' } }) as never
    ]).map((x) => x.target)).toEqual(['b', 'a'])
  })

  it('does not move a target forward for a late row with an older timestamp', () => {
    const list = [{ target: 'new', eventCount: 1, lastSeen: 10 }, { target: 'old', eventCount: 1, lastSeen: 5 }]
    const out = mergeKnownTargets(list, [makeEvent('x', 1, 'shell', { targetId: 'OLD' }) as never])
    expect(out).toEqual([{ target: 'new', eventCount: 1, lastSeen: 10 }, { target: 'old', eventCount: 2, lastSeen: 5 }])
  })
})
