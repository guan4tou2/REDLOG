// @vitest-environment jsdom
// 2026-11-08 (#650): 100% fits the track to what the scroller shows. The
// Timeline renders a spinner before its first page, and measuring "on mount"
// ran then — no elements, no observer — so the track kept its 2000px
// placeholder in the real app and 100% was never the whole span.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { deferred, installTimelineBridge, makeEvent, page, type Page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = Date.UTC(2026, 10, 8, 3, 0, 0)
const VISIBLE_W = 900

let b: TimelineBridge
beforeEach(() => {
  b = installTimelineBridge({ timelineMode: 'standard' })
  try { localStorage.clear() } catch { /* ignore */ }
  // A ResizeObserver that reports once on observe, as the real one does.
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {}
    observe(): void { this.cb([{ contentRect: { width: VISIBLE_W + 15, height: 400 } }]) }
    unobserve(): void {}
    disconnect(): void {}
  }
  // The scroller's visible width (jsdom lays nothing out).
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('cursor-grab') ? VISIBLE_W : 0
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('zoom 100% after the first page arrives', () => {
  it('fits the track to the scroller, not the 2000px placeholder', async () => {
    const first = deferred<Page>()
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) => (opts.cursor ? new Promise(() => {}) : first.promise))
    const { default: TimelinePanel } = await import('../src/renderer/src/components/Timeline')
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    // Spinner first: nothing to measure yet.
    expect(document.querySelector('div.cursor-grab')).toBeNull()
    first.resolve(page([makeEvent('e1', T0), makeEvent('e2', T0 + 60_000)]))
    await waitFor(() => expect(document.querySelector('div.cursor-grab')).not.toBeNull())
    const track = () => (document.querySelector('div.cursor-grab')!.firstElementChild as HTMLElement).style.width
    await waitFor(() => expect(track()).toBe(`${VISIBLE_W}px`))
  })
})
