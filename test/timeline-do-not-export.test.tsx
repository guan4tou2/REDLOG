// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const FAILED = 'Exclusion from export was not changed'

const switchButton = (): HTMLElement =>
  screen.getByRole('button', { name: /^(Exclude from export|Excluded from export)$/ })

// The do-not-export switch ignored a refused write (null) and had no catch, and
// the flag read for a selection could land after the operator had moved on,
// showing one event's flag on another.
describe('the do-not-export switch', () => {
  let b: TimelineBridge
  let events: Record<string, unknown>
  const mount = (focusEventId: string): ReturnType<typeof render> =>
    render(<I18nProvider><FilterProvider><ToastContainer /><TimelinePanel focusEventId={focusEventId} /></FilterProvider></I18nProvider>)

  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0), makeEvent('e2', T0 + 1000)]))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('says so and does not flip when the write is refused or fails', async () => {
    const toggle = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('locked'))
    events.toggleDoNotExport = toggle
    mount('e1')
    await waitFor(() => expect(switchButton()).toBeTruthy())
    fireEvent.click(switchButton())
    await screen.findByText(FAILED)
    expect(switchButton().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(switchButton())
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByText(FAILED).length).toBeGreaterThan(0))
    expect(switchButton().getAttribute('aria-pressed')).toBe('false')
  })

  it('flips on the written value', async () => {
    events.toggleDoNotExport = vi.fn(async () => true)
    mount('e1')
    await waitFor(() => expect(switchButton()).toBeTruthy())
    fireEvent.click(switchButton())
    await waitFor(() => expect(switchButton().getAttribute('aria-pressed')).toBe('true'))
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  it('ignores a reply for an event that is no longer selected', async () => {
    const reads: Record<string, ReturnType<typeof deferred<boolean>>> = {}
    events.isDoNotExport = vi.fn((id: string) => { reads[id] = deferred<boolean>(); return reads[id].promise })
    const write = deferred<boolean | null>()
    events.toggleDoNotExport = vi.fn(() => write.promise)
    const view = mount('e1')
    await waitFor(() => expect(reads.e1).toBeTruthy())
    fireEvent.click(switchButton())
    view.rerender(<I18nProvider><FilterProvider><ToastContainer /><TimelinePanel focusEventId="e2" /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(reads.e2).toBeTruthy())
    await act(async () => { reads.e2.resolve(false) })
    // e1's flag read and e1's write both land after e2 was selected.
    await act(async () => { reads.e1.resolve(true); write.resolve(true) })
    expect(switchButton().getAttribute('aria-pressed')).toBe('false')
  })
})
