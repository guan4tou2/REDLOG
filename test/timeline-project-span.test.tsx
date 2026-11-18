// @vitest-environment jsdom
// 069 B: 全階段 shows the project's span from `events:span`, so it no longer
// waits for every older page to load before it can say how long the session is.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'
import { formatDateTime } from '../src/renderer/src/lib/time'

const AT = Date.UTC(2026, 10, 8, 10, 0, 0)
const MIN = 60_000

let b: TimelineBridge
beforeEach(() => {
  b = installTimelineBridge({ timelineMode: 'standard' })
  try { localStorage.clear(); localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Two loaded rows ten minutes apart, with older pages still unread. The next
// page request stays in flight, so `hasMore` stays true.
async function mount(): Promise<void> {
  b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
    opts.cursor ? new Promise(() => {}) : page([makeEvent('e2', AT), makeEvent('e1', AT - 10 * MIN)], true, 'c1'))
  b.count.mockResolvedValue(500)
  const { default: TimelinePanel } = await import('../src/renderer/src/components/Timeline')
  render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
}

describe('the whole-session span', () => {
  it('comes from events:span while older rows are still unloaded', async () => {
    b.span.mockResolvedValue({ first: AT - (25 * 60 + 7) * MIN, last: AT })
    await mount()
    await waitFor(() => expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session (25h 07m)'))
    // Asked over the same filter as the total.
    expect(b.span.mock.calls[0][0]).toEqual(b.count.mock.calls[0][0])
  })

  it('says nothing while older rows are unloaded and the span is unknown', async () => {
    b.span.mockRejectedValue(new Error('no span'))
    await mount()
    await waitFor(() => expect(b.span).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session'))
  })
})

// The overview says how long the whole thing is and what is not loaded: its
// ends are the project's first and last rows, and the unread part is a
// labelled segment, not a ⋮ at the edge or an empty stretch of the strip.
describe('the overview strip', () => {
  it('labels its ends with the project span and names the unloaded part', async () => {
    const first = AT - (25 * 60 + 7) * MIN
    b.span.mockResolvedValue({ first, last: AT })
    await mount()
    await waitFor(() => expect(screen.getByTestId('minimap-ends').textContent).toContain(formatDateTime(first, { seconds: false })))
    expect(screen.getByTestId('minimap-ends').textContent).toContain(formatDateTime(AT, { seconds: false }))
    expect(screen.getByTestId('minimap-unloaded').textContent).toBe('Not loaded')
    expect(screen.queryByTestId('minimap-partial')).toBeNull()
  })

  it('names the focus window for assistive technology without printing it across the strip', async () => {
    b.span.mockResolvedValue({ first: AT - 10 * MIN, last: AT })
    await mount()
    const win = await screen.findByTestId('minimap-window')
    expect(win.getAttribute('aria-label')).toBe('Focus window')
    expect(screen.getByTestId('timeline-minimap').textContent).not.toContain('Focus window')
  })

  it('has no unloaded segment once nothing older is left', async () => {
    b.span.mockResolvedValue({ first: AT - 10 * MIN, last: AT })
    b.queryPage.mockResolvedValue(page([makeEvent('e2', AT), makeEvent('e1', AT - 10 * MIN)]))
    const { default: TimelinePanel } = await import('../src/renderer/src/components/Timeline')
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await screen.findByTestId('minimap-ends')
    expect(screen.queryByTestId('minimap-unloaded')).toBeNull()
  })
})
