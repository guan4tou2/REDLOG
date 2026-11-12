// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000

afterEach(() => cleanup())

/** Every ancestor that cuts its content off at its own box. */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cls = typeof p.className === 'string' ? p.className : ''
    if (/(^|\s)overflow(-[xy])?-(hidden|auto|scroll|clip)(\s|$)/.test(cls) || /overflow/.test(p.getAttribute('style') ?? '')) out.push(p)
  }
  return out
}

// Reported from the real app: clicking a counted cluster dot opened a popup
// that looked empty. The list was drawn inside the track's scroller, which
// clips vertically; in the standard mode that scroller is one 44px row, so a
// 210px list showed its header and nothing under it.
describe.each(['standard', 'lanes'] as const)('the cluster popup (%s)', (mode) => {
  beforeEach(() => {
    const b = installTimelineBridge({ timelineMode: mode })
    try { localStorage.clear() } catch { /* ignore */ }
    // Three events at one instant: one pixel, one counted cluster.
    b.queryPage.mockResolvedValue(page([makeEvent('c1', T0), makeEvent('c2', T0), makeEvent('c3', T0)]))
  })

  it('lists every member, outside any clipping container', async () => {
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBe(1))
    fireEvent.click(document.querySelector('[data-timeline-event]') as HTMLElement)
    const popup = await waitFor(() => {
      const el = document.querySelector('[data-timeline-popup]') as HTMLElement | null
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    const text = popup.textContent ?? ''
    for (const id of ['c1', 'c2', 'c3']) expect(text).toContain(`cmd ${id}`)
    // The popup's own list scrolls; nothing between it and the panel clips it.
    const list = popup.firstElementChild as HTMLElement
    expect(clippingAncestors(list).filter((a) => popup.contains(a) === false)).toEqual([])
  })
})
