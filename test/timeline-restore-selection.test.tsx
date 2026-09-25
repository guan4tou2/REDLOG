// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const KEY = 'redlog-timeline-focus-event'
// The detail panel's resize handle carries this title, and only renders while
// the panel is open for a selected event.
const DETAIL_HANDLE = (en as Record<string, string>)['timeline.resizeDetailPanel']

const mount = (props: { focusEventId?: string } = {}): void => {
  render(<I18nProvider><FilterProvider><TimelinePanel {...props} /></FilterProvider></I18nProvider>)
}

// The Timeline restores the event that was selected when it was last open.
// It never did: on mount the save effect ran with nothing selected and removed
// the stored id, so by the time the first page had loaded and the restore
// effect looked, the id was gone.
describe('the Timeline restores the last selected event', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    b.query.mockResolvedValue([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)])
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('re-selects the stored event once the first page holds it', async () => {
    localStorage.setItem(KEY, 'e2')
    mount()
    expect(await screen.findByTitle(DETAIL_HANDLE)).not.toBeNull()
    expect(localStorage.getItem(KEY)).toBe('e2')
  })

  it('lets an explicit focus win over the restore', async () => {
    localStorage.setItem(KEY, 'e2')
    mount({ focusEventId: 'e1' })
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    // The restore has had its one attempt, and stood aside for the focus.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTitle(DETAIL_HANDLE)).toBeNull()
  })
})
