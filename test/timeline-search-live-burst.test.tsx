// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const box = (): HTMLInputElement => screen.getByTestId('timeline-search-input') as HTMLInputElement
const settle = async (ms = 50): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }

// Measured: text typed into the Timeline's `/` box during a 50 events/s burst
// was gone when the burst ended, and the box had lost focus. The box has to
// keep its node, its value and its focus across any number of live flushes.
describe.each(['standard', 'lanes'] as const)('the search box under a live burst (%s)', (timelineMode) => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode })
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it.each([
    ['all loaded', false],
    ['older pages left', true]
  ])('keeps value, focus and node across 30 batches (%s)', async (_label, hasMore) => {
    const first = Array.from({ length: 40 }, (_, i) => makeEvent(`p${i}`, T0 + i * 1000, i % 3 ? 'http' : 'shell'))
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page(first, hasMore, hasMore ? 'c1' : null))
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('timeline-search-input')).toBeTruthy())
    await settle()

    const input = box()
    act(() => { input.focus() })
    fireEvent.change(input, { target: { value: 'nma' } })
    await settle(10)
    fireEvent.change(input, { target: { value: 'nmap' } })
    expect(document.activeElement).toBe(input)

    let n = 0
    for (let batch = 0; batch < 30; batch++) {
      const rows = Array.from({ length: 5 }, () => {
        n++
        return makeEvent(`live-${n}`, T0 + 60_000 + n * 20, n % 4 ? 'http' : 'shell')
      })
      await act(async () => { b.emitBatch(rows) })
      await settle(20)
      // Typing continues during the burst.
      if (batch === 10) fireEvent.change(box(), { target: { value: 'nmap -sV' } })
    }
    await settle(300)

    expect(box()).toBe(input)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('nmap -sV')
    expect(document.activeElement).toBe(input)
  })
})

// The project's stored Timeline settings arrive with `project.active()`, one
// IPC round trip that a burst holds up. Applied after the operator had started
// typing, a stored query replaced the box, and a stored focus anchor resolved
// to a chain whose arrival cleared it.
describe('the search box when stored settings arrive during a burst', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it.each([
    ['a stored query', { 'redlog-timeline-filter-query:p1': 'old query' }],
    ['a stored focus anchor', { 'redlog-timeline-focus-anchor:p1': 'p3' }],
    ['both', { 'redlog-timeline-filter-query:p1': 'old query', 'redlog-timeline-focus-anchor:p1': 'p3' }]
  ])('keeps what the operator typed over %s', async (_label, stored) => {
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v)
    const project = deferred<{ id: string; name: string }>()
    const w = window as unknown as { redlog: { project: { active: () => Promise<unknown> }; events: Record<string, unknown> } }
    w.redlog.project.active = () => project.promise
    w.redlog.events.causalChain = async () => ({
      anchorFound: true, events: [makeEvent('p3', T0 + 3000)], edges: [], truncated: false, unavailableCauseIds: []
    })
    const first = Array.from({ length: 40 }, (_, i) => makeEvent(`p${i}`, T0 + i * 1000, i % 3 ? 'http' : 'shell'))
    b.queryPage.mockImplementation(async () => page(first))
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByTestId('timeline-search-input')).toBeTruthy())
    const input = box()
    act(() => { input.focus() })
    fireEvent.change(input, { target: { value: 'nmap' } })
    for (let i = 0; i < 10; i++) {
      await act(async () => { b.emitBatch([makeEvent(`l${i}`, T0 + 90_000 + i, 'http')]) })
      await settle(20)
    }
    await act(async () => { project.resolve({ id: 'p1', name: 'Proj' }) })
    await settle(300)

    expect(box()).toBe(input)
    expect(input.value).toBe('nmap')
    expect(document.activeElement).toBe(input)
    // And it is what the project now remembers.
    expect(localStorage.getItem('redlog-timeline-filter-query:p1')).toBe('nmap')
  })
})
