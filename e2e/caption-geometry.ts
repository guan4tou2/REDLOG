import { expect, type Page } from '@playwright/test'

// Does anything the page draws sit under the OS window buttons?
//
// On Windows and Linux the main window's minimise / maximise / close buttons are
// drawn by the OS over the top-right of the page (`titleBarOverlay`,
// src/main/windows.ts). Chromium reports the strip they leave to the page as
// `navigator.windowControlsOverlay.getTitlebarAreaRect()`; everything to the
// right of that rectangle, within its height, is the buttons.
//
// UNITS. One family throughout: `getBoundingClientRect()` / `Range` client rects,
// which are viewport CSS pixels — the SAME space `getTitlebarAreaRect()` and
// `innerWidth` use. The app draws at `body { zoom }`, so these are the screen
// pixels, not the layout pixels `offset*` would give (CLAUDE.md, "Measuring
// geometry in e2e"). Never mix the two families here.

export interface CaptionState {
  /** `navigator.windowControlsOverlay.visible`; false when the API is absent. */
  visible: boolean
  /** The part of the window the OS buttons own, in viewport CSS pixels. */
  strip: { left: number; top: number; right: number; bottom: number } | null
  /** innerWidth, the app zoom, and the two published properties, for the message. */
  note: string
}

export async function captionState(page: Page): Promise<CaptionState> {
  return page.evaluate(() => {
    const api = (navigator as unknown as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect } }).windowControlsOverlay
    const root = getComputedStyle(document.documentElement)
    const note = `innerWidth=${window.innerWidth} zoom=${document.body.style.getPropertyValue('--app-zoom') || getComputedStyle(document.body).zoom} --wco-inset-right=${root.getPropertyValue('--wco-inset-right').trim()} --wco-height=${root.getPropertyValue('--wco-height').trim()}`
    if (!api || !api.visible) return { visible: false, strip: null, note }
    const r = api.getTitlebarAreaRect()
    return { visible: true, strip: { left: r.x + r.width, top: 0, right: window.innerWidth, bottom: r.y + r.height }, note }
  })
}

/** Why the overlay rectangle cannot be trusted yet, or '' when it can. After a
 *  window resize Chromium can still report the previous size's rectangle for a
 *  moment (800 wide, window now 1400: the "buttons" would be 713 px), and the
 *  app republishes `--wco-inset-right` a frame or two later. The bound is the
 *  one in lib/captionInsets.ts (`maxButtonsReachPx`): smaller of 40% of the
 *  window and 400 px. */
async function staleness(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (navigator as unknown as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect } }).windowControlsOverlay
    if (!api || !api.visible) return '' // nothing to be stale: the caller reports visibility
    const r = api.getTitlebarAreaRect()
    const strip = window.innerWidth - (r.x + r.width)
    const max = Math.min(0.4 * window.innerWidth, 400)
    const zoomRaw = parseFloat(document.body.style.getPropertyValue('--app-zoom')) || parseFloat(getComputedStyle(document.body).zoom) || 0.9
    const published = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wco-inset-right'))
    const expected = strip / zoomRaw
    const rect = `titlebar area x=${r.x} width=${r.width}, innerWidth=${window.innerWidth}, buttons strip ${strip.toFixed(1)}px (limit ${max.toFixed(1)}), --wco-inset-right=${published}px, expected ${expected.toFixed(1)}px at zoom ${zoomRaw}`
    if (!(strip > 0) || strip > max) return `the overlay rectangle is not consistent with the window: ${rect}`
    if (!Number.isFinite(published) || Math.abs(published - expected) > 1) return `the published inset does not match the rectangle: ${rect}`
    return ''
  })
}

/** `captionState`, once the overlay rectangle is consistent with the window and
 *  the published inset follows it. If it never becomes so, the rectangle stayed
 *  stale — an app bug, not a slow window, and the message says so. */
export async function settledCaptionState(page: Page): Promise<CaptionState> {
  await expect
    .poll(() => staleness(page), {
      timeout: 5_000,
      intervals: [50, 100, 200, 400],
      message: 'the window controls overlay rectangle stayed stale after the resize (the app never converged on it)'
    })
    .toBe('')
  return captionState(page)
}

const INTERACTIVE = 'button, a, input, select, textarea, [role=button], [role=tab], [tabindex]'

/**
 * Fails, naming each element and both rectangles, when an interactive element or
 * a piece of text is visible inside the OS buttons' rectangle. An element that a
 * full-window backdrop covers is the backdrop's to answer for, not its own:
 * `elementFromPoint` at the middle of the overlap says who is on top.
 */
export async function expectClearOfCaptionControls(page: Page, label: string): Promise<void> {
  const state = await settledCaptionState(page)
  expect(state.visible, `${label}: the window controls overlay is not visible (${state.note})`).toBe(true)
  const strip = state.strip!
  const hits = await page.evaluate(({ strip, selector }) => {
    const out: string[] = []
    const overlap = (r: { left: number; top: number; right: number; bottom: number }) => {
      const left = Math.max(r.left, strip.left), right = Math.min(r.right, strip.right)
      const top = Math.max(r.top, strip.top), bottom = Math.min(r.bottom, strip.bottom)
      return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null
    }
    const describe = (el: Element): string => {
      const id = el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''
      const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return `<${el.tagName.toLowerCase()}${id}> "${text}"`
    }
    const rect = (r: { left: number; top: number; right: number; bottom: number }) => `[${r.left.toFixed(1)},${r.top.toFixed(1)} → ${r.right.toFixed(1)},${r.bottom.toFixed(1)}]`
    const onTop = (el: Element, o: { left: number; top: number; right: number; bottom: number }): boolean => {
      const hit = document.elementFromPoint((o.left + o.right) / 2, (o.top + o.bottom) / 2)
      return !!hit && (el.contains(hit) || hit.contains(el))
    }
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      const b = el.getBoundingClientRect()
      if (b.width <= 1.5 || b.height <= 1.5) continue // sr-only and other 1px boxes
      const o = overlap(b)
      if (o && onTop(el, o)) out.push(`interactive ${describe(el)} ${rect(b)} overlaps buttons ${rect(strip)} at ${rect(o)}`)
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent || !n.textContent.trim()) continue
      const parent = n.parentElement
      if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue
      const cs = getComputedStyle(parent)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const b of Array.from(range.getClientRects())) {
        if (b.width <= 1.5 || b.height <= 1.5) continue
        const o = overlap(b)
        if (o && onTop(parent, o)) out.push(`text ${describe(parent)} ${rect(b)} overlaps buttons ${rect(strip)} at ${rect(o)}`)
      }
    }
    return Array.from(new Set(out))
  }, { strip, selector: INTERACTIVE })
  expect(hits, `${label}: something is drawn under the OS window buttons (${state.note})`).toEqual([])
}
