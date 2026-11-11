// @vitest-environment jsdom
//
// Ratchet: Timeline text and hit areas.
//
// The app renders at `body { zoom: 0.9 }`, so a control built at 24 CSS px is
// 21.6 device px. Interactive hit areas here are held to 27 CSS px (≈24 device
// px) and text to 11 CSS px. jsdom has no layout, so sizes are read from what
// the markup claims: an inline width/height, the Tailwind size classes, an
// `after:` pseudo-element that widens the hit area, or — for a control sized by
// its text — line height plus padding. That is an estimate, which is why this
// is a ratchet on a count rather than a measurement.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const MIN_HIT = 27
const MIN_TEXT = 11

afterEach(() => cleanup())

const SCALE: Record<string, number> = { px: 1 }
const unit = (v: string): number | null => {
  const bracket = /^\[(-?\d+(?:\.\d+)?)px\]$/.exec(v)
  if (bracket) return Number(bracket[1])
  if (v in SCALE) return SCALE[v]
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) * 4 : null
}
const classes = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
const pick = (cls: string[], prefix: string): number | null => {
  for (const c of cls) if (c.startsWith(prefix)) { const n = unit(c.slice(prefix.length)); if (n !== null) return n }
  return null
}
const pxStyle = (el: HTMLElement, prop: 'width' | 'height'): number | null => {
  const v = el.style[prop]
  return v && v.endsWith('px') ? Number(v.slice(0, -2)) : null
}

/** What a pseudo-element hit extension adds on each axis. */
function extension(cls: string[], axis: 'x' | 'y'): number {
  const sides = axis === 'y' ? ['top', 'bottom'] : ['left', 'right']
  let total = 0
  const all = pick(cls, 'after:-inset-')
  const ax = pick(cls, `after:-inset-${axis}-`)
  if (ax !== null) total += 2 * ax
  else if (all !== null) total += 2 * all
  for (const s of sides) { const n = pick(cls, `after:-${s}-`); if (n !== null) total += n }
  return total
}

function hitSize(el: HTMLElement, axis: 'x' | 'y'): number {
  const cls = classes(el)
  const dim = axis === 'y' ? 'h' : 'w'
  const styled = pxStyle(el, axis === 'y' ? 'height' : 'width')
  const fixed = pick(cls, `${dim}-`) ?? pick(cls, `size-`)
  const min = pick(cls, `min-${dim}-`)
  let base = Math.max(styled ?? 0, fixed ?? 0, min ?? 0)
  // Stretched to its parent: measure the parent.
  if (!base && axis === 'y' && (cls.includes('h-full') || cls.includes('inset-y-0')) && el.parentElement) {
    base = hitSize(el.parentElement, 'y')
  }
  if (!base) {
    if (cls.includes('w-full') && axis === 'x') return Infinity
    const lead = cls.includes('leading-none') ? 12 : cls.includes('text-sm') ? 20 : 16
    const pad = pick(cls, axis === 'y' ? 'py-' : 'px-') ?? pick(cls, 'p-') ?? 0
    const text = axis === 'y' ? lead : (el.textContent ?? '').length * 7
    base = text + 2 * pad
  }
  return base + extension(cls, axis)
}

const CONTROLS = 'button, input, select, [role="switch"], [role="checkbox"], [data-testid^="minimap-window-"]'

function undersized(root: ParentNode): string[] {
  const out: string[] = []
  for (const el of root.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (el.closest('[aria-hidden="true"], [hidden]')) continue
    if (el.matches('[data-testid="minimap-window-preview"]')) continue
    const h = hitSize(el, 'y')
    const w = hitSize(el, 'x')
    if (h < MIN_HIT || w < MIN_HIT) {
      const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24)
      out.push(`${el.tagName.toLowerCase()} ${name} ${Math.round(w)}x${Math.round(h)}`)
    }
  }
  return out
}

function smallText(root: ParentNode): string[] {
  const out: string[] = []
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const fs = el.style.fontSize
    if (fs && fs.endsWith('px') && Number(fs.slice(0, -2)) < MIN_TEXT) out.push(`${el.tagName} ${fs} "${(el.textContent ?? '').slice(0, 12)}"`)
    for (const c of classes(el)) {
      const m = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(c)
      if (m && Number(m[1]) < MIN_TEXT) out.push(`${el.tagName} ${c}`)
    }
  }
  return out
}

/** Controls still under 27 CSS px by the estimate above, with an event
 *  selected. It may only go down; it is 0 today. */
const UNDERSIZED_BASELINE = 0

describe.each(['standard', 'lanes'] as const)('Timeline hit areas and text (%s)', (mode) => {
  it('holds controls to 27 CSS px and text to 11 CSS px', async () => {
    const b = installTimelineBridge({ timelineMode: mode })
    try { localStorage.clear() } catch { /* ignore */ }
    // A cluster (three at one instant), a lone dot, and a search value so the
    // clear button is drawn.
    b.queryPage.mockResolvedValue(page([makeEvent('c1', T0 - 60_000), makeEvent('c2', T0 - 60_000), makeEvent('c3', T0 - 60_000), makeEvent('s1', T0)]))
    const { container } = render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(container.querySelectorAll('[data-timeline-event]').length).toBe(2))
    const search = container.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null
    if (search) fireEvent.change(search, { target: { value: 'cmd' } })
    // Open the cluster so its popover's controls are measured too.
    const cluster = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find((el) => /\d/.test(el.textContent ?? ''))
    if (cluster) fireEvent.click(cluster)

    expect(smallText(container)).toEqual([])
    const under = undersized(container)
    expect(under, under.join('\n')).toEqual([])
  })
})

describe('Timeline hit areas with an event selected', () => {
  it('stays at or under the baseline for the detail bar and pane', async () => {
    const b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
    b.queryPage.mockResolvedValue(page([makeEvent('s0', T0 - 60_000), makeEvent('s1', T0)]))
    const { container } = render(<I18nProvider><FilterProvider><TimelinePanel focusEventId="s1" /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(container.querySelector('[data-testid="timeline-detail-body"]')).not.toBeNull())
    expect(smallText(container)).toEqual([])
    const under = undersized(container)
    expect(under.length, under.join('\n')).toBeLessThanOrEqual(UNDERSIZED_BASELINE)
  })
})
