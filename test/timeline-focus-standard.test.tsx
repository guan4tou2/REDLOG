// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    // The one standard track draws both events; the swim-lane rows are absent.
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBe(2))
    expect(screen.queryByTestId('timeline-standard-track')).not.toBeNull()
  })

  it('draws the ruler: no lane label column, the track is the scroller\'s first child', async () => {
    render(<I18nProvider><FilterProvider><TimelinePanel focusEventId="e1" /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBe(2))
    const scroller = screen.getByTestId('timeline-lane-scroll')
    expect((scroller.firstElementChild as HTMLElement).classList.contains('cursor-grab')).toBe(true)
    expect(scroller.textContent).not.toContain((en as Record<string, string>)['timeline.laneChipHint'] ?? '\u0000')
  })

  it('marks the newest event, and the selected one only while something is selected', async () => {
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    const latest = await screen.findByTestId('timeline-marker-latest')
    expect(latest.textContent).toMatch(/\d{2}:\d{2}:\d{2} /)
    expect(latest.tagName).toBe('BUTTON')
    expect(screen.queryByTestId('timeline-marker-focus')).toBeNull()
    fireEvent.click(document.querySelectorAll('[data-timeline-event]')[0])
    const focus = await screen.findByTestId('timeline-marker-focus')
    expect(focus.tagName).not.toBe('BUTTON')
    // Markers are not dots: the roving-tabindex walk must not count them.
    expect(document.querySelectorAll('[data-timeline-event]').length).toBe(2)
  })

  it('clicking [Latest] resumes follow', async () => {
    const FOLLOW = 'redlog-timeline-follow-mode'
    try { localStorage.setItem(FOLLOW, '0') } catch { /* ignore */ }
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    const latest = await screen.findByTestId('timeline-marker-latest')
    expect(localStorage.getItem(FOLLOW)).toBe('0')
    fireEvent.click(latest)
    await waitFor(() => expect(localStorage.getItem(FOLLOW)).toBe('1'))
  })
})
