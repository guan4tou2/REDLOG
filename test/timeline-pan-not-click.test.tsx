// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
// The bar is rendered for exactly as long as an event is selected, so its
// presence is the selection.
const SELECTED = 'timeline-detail-panel'

const mount = (): void => {
  render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
}

const dots = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-event]'))

// Panning the track is a press, a move and a release. When the press lands on
// a dot — a 20px hit box in a 36px lane, most often the SELECTED dot, which is
// both what the operator is looking at and drawn on top of its neighbours —
// the release over that same dot is still a `click`, and the dot's click
// toggles the selection off. So dragging the timeline a few pixels cleared the
// selection on the event the operator had just picked.
describe('panning the track is not a click on the dot underneath', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    b.queryPage.mockResolvedValue(
      page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)])
    )
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const select = async (): Promise<HTMLElement> => {
    mount()
    // Three events far enough apart not to collapse into one cluster dot,
    // which has a different click (it opens the popup) and would prove
    // nothing about selection.
    await waitFor(() => expect(dots()).toHaveLength(3))
    const dot = dots()[0]
    fireEvent.click(dot)
    expect(await screen.findByTestId(SELECTED)).not.toBeNull()
    return dot
  }

  it('keeps the selection when the press that started the pan ends on the same dot', async () => {
    const dot = await select()

    fireEvent.mouseDown(dot, { button: 0, clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 160 })
    fireEvent.mouseUp(window, { clientX: 160 })
    // A deliberate click's count: what a real click that ends a pan carries.
    fireEvent.click(dot, { detail: 1 })

    expect(screen.queryByTestId(SELECTED)).not.toBeNull()
  })

  it('still toggles the selection off on a press that did not move', async () => {
    const dot = await select()

    fireEvent.mouseDown(dot, { button: 0, clientX: 100 })
    fireEvent.mouseUp(window, { clientX: 100 })
    fireEvent.click(dot, { detail: 1 })

    await waitFor(() => expect(screen.queryByTestId(SELECTED)).toBeNull())
  })

  it('counts a press that only jitters as a click, not a pan', async () => {
    const dot = await select()

    fireEvent.mouseDown(dot, { button: 0, clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 102 })
    fireEvent.mouseUp(window, { clientX: 102 })
    fireEvent.click(dot, { detail: 1 })

    await waitFor(() => expect(screen.queryByTestId(SELECTED)).toBeNull())
  })
})
