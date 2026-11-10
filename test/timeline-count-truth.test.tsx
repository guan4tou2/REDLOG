// @vitest-environment jsdom
//
// Spec 069 FR-009: the count in the Timeline header comes from what is loaded,
// and a page that does not reach the start says how many events there really
// are rather than letting the loaded count pass as the whole.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
afterEach(() => cleanup())

describe.each(['standard', 'lanes'] as const)('Timeline header count (%s mode)', (mode) => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: mode })
    try { localStorage.clear(); localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
  })
  const draw = (): void => { render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>) }

  it('counts exactly what is loaded when nothing older exists', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)]))
    draw()
    await waitFor(() => expect(screen.getByTestId('timeline-range-status').textContent).toBe('Total 3 events'))
  })

  it('states the real total when older events remain', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e2', T0 - 1000), makeEvent('e3', T0)], true, 'older'))
    b.count.mockResolvedValue(250)
    draw()
    await waitFor(() => expect(screen.getByTestId('timeline-range-status').textContent).toBe('2 of 250 events · scroll back for older'))
  })

  it('does not present the loaded count as the total when the total cannot be read', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e3', T0)], true, 'older'))
    b.count.mockRejectedValue(new Error('down'))
    draw()
    await waitFor(() => expect(screen.getByTestId('timeline-range-status').textContent).toContain('total unavailable'))
  })
})
