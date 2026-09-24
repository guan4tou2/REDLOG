// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { getDisplayZone, setDisplayZone } from '../src/renderer/src/lib/time'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'
import type { RedLogEvent } from '../src/core/db/events'

const AT = Date.UTC(2026, 8, 24, 7, 4, 5) // 2026-09-24 07:04:05Z

let b: TimelineBridge
beforeEach(() => {
  b = installTimelineBridge()
  try { localStorage.clear() } catch { /* ignore */ }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setDisplayZone('local')
})

// Spec 033 US5 (FR-013, SC-005): the zone is chosen once, in Settings ▸
// General, and every surface that prints an event time prints it there.
describe('the display zone on each surface', () => {
  it('is chosen in Settings ▸ General, Local or UTC', async () => {
    const { default: GeneralPage } = await import('../src/renderer/src/components/settings/GeneralPage')
    const config = { engagement: { id: 'e1', name: 'Eng' }, operator: { id: 'op-1', name: 'Op' } }
    render(
      <I18nProvider>
        <GeneralPage config={config as never} setConfig={() => {}} />
      </I18nProvider>
    )
    const local = screen.getByRole('button', { name: 'Local' })
    const utc = screen.getByRole('button', { name: 'UTC' })
    expect(local.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(utc)
    expect(getDisplayZone()).toBe('utc')
    await waitFor(() => expect(utc.getAttribute('aria-pressed')).toBe('true'))
  })

  // One event, so the Timeline draws its toolbar rather than the empty state.
  // jsdom has no width, so the panel asks for the next page at once; that
  // request stays in flight.
  async function mountTimeline(): Promise<void> {
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page([makeEvent('e1', AT)]))
    const { default: TimelinePanel } = await import('../src/renderer/src/components/Timeline')
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
  }

  it('is not a Timeline setting: the ⋯ menu has no zone picker', async () => {
    await mountTimeline()
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    expect(screen.queryByTestId('timeline-tz-select')).toBeNull()
  })

  it('prints the Timeline event time in UTC, marked Z', async () => {
    setDisplayZone('utc')
    await mountTimeline()
    const dot = document.querySelector('[data-timeline-event]') as HTMLElement
    expect(dot.getAttribute('title') ?? dot.getAttribute('aria-label') ?? '').toContain('07:04:05Z')
  })

  it('prints the marker detail in UTC, marked Z', async () => {
    setDisplayZone('utc')
    const { MarkerDetail } = await import('../src/renderer/src/components/MarkerDetail')
    const marker = makeEvent('m1', AT, 'marker', {
      data: { subtype: 'marker', title: 'foothold', severity: 'info', notes: '', category: 'custom' }
    }) as unknown as RedLogEvent
    render(
      <I18nProvider>
        <MarkerDetail
          event={marker} fold={undefined} linkedScreenshots={[]}
          operatorLabel={(id) => id} onAmend={() => {}} onSelect={() => {}} onResolveOriginal={() => {}}
        />
      </I18nProvider>
    )
    expect(document.body.textContent).toContain('2026-09-24 07:04:05Z')
  })

  it('prints the FilterBar time chip in UTC, marked Z', async () => {
    setDisplayZone('utc')
    const { FilterBar } = await import('../src/renderer/src/components/FilterBar')
    function SinceAt(): null {
      const { setTimeRange } = useSharedFilter()
      useEffect(() => { setTimeRange({ since: AT }) }, [setTimeRange])
      return null
    }
    render(<I18nProvider><FilterProvider><SinceAt /><FilterBar /></FilterProvider></I18nProvider>)
    expect(await screen.findByText(/07:04Z/)).not.toBeNull()
  })
})
