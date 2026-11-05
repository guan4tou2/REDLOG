// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

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
    // Spec 038 moved the first load from `events.query` to `events.queryPage`,
    // so scripting `query` leaves the panel with nothing and it renders the
    // empty state — which is what the restore had nothing to select from.
    b.queryPage.mockResolvedValue(
      page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)])
    )
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
    // The restore has had its one attempt, and stood aside for the focus: the
    // pane is open on the focused event, not on the stored one.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTitle(DETAIL_HANDLE)).not.toBeNull()
    expect(localStorage.getItem(KEY)).toBe('e1')
  })
})

describe('a remembered selection older than the drawn range', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    b.queryPage.mockResolvedValueOnce({ ...page([makeEvent('e3', T0)]), hasMore: true, nextCursor: 'older' })
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 5000)]))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('is loaded back to and opened, as a selection made in the list should be', async () => {
    localStorage.setItem(KEY, 'e1')
    b.matchIds.mockResolvedValue(['e1'])
    mount()
    expect(await screen.findByTitle(DETAIL_HANDLE)).not.toBeNull()
    expect(localStorage.getItem(KEY)).toBe('e1')
  })

  it('stays quiet when the remembered event is gone or filtered out', async () => {
    localStorage.setItem(KEY, 'gone')
    b.matchIds.mockResolvedValue([])
    mount()
    await waitFor(() => expect(b.matchIds).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByTitle(DETAIL_HANDLE)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
