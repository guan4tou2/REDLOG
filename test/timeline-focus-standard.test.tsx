// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const DETAIL_HANDLE = (en as Record<string, string>)['timeline.resizeDetailPanel']

afterEach(() => cleanup())

// Search, Loot and Targets hand the Timeline an event to open. Selecting it
// used to hang off the swim-lane scroller existing, so in the standard mode —
// which draws no lanes — the jump landed on an unselected list.
describe('the Timeline opens an event it is sent to, in either mode', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 1000), makeEvent('e2', T0)]))
  })

  it('selects the focused event with no swim lanes on screen', async () => {
    render(<I18nProvider><FilterProvider><TimelinePanel focusEventId="e1" /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(screen.queryByTitle(DETAIL_HANDLE)).not.toBeNull())
    expect(document.querySelector('[data-timeline-event]')).toBeNull()
  })
})
