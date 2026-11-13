// @vitest-environment jsdom
//
// The Timeline's control density (owner, 2026-11-14): one toolbar row instead
// of two, the moved controls reachable through 更多 with their shortcuts, the
// event count said once, the attribution warning as a compact toolbar status
// that only appears under the old banner's condition, the legend as a popover,
// and an event's type stated by every dot in words.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { TimelineToolbar } from '../src/renderer/src/components/timeline/TimelineToolbar'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'
import type { LaneId } from '../src/renderer/src/lib/timelineDomain'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const EN = en as Record<string, string>
const T0 = 1_700_000_000_000
const EIGHT: LaneId[] = ['shell', 'agent', 'http_navigation', 'screenshot', 'marker', 'loot', 'scope', 'system']

type Props = Parameters<typeof TimelineToolbar>[0]
function Harness(over: Partial<Props>): JSX.Element {
  const { t } = useI18n()
  const props: Props = {
    t, timeRange: null, setTimeRange: vi.fn(), hasMore: false, loadedCount: 3, loadedSpanMs: null, projectSpanMs: null,
    total: { state: 'ok', value: 3 }, onRetryTotal: vi.fn(), onLoadMore: vi.fn(),
    zoom: 1.5, onZoomOut: vi.fn(), onZoomIn: vi.fn(), onResetZoom: vi.fn(), anchorTs: null,
    mode: 'standard', onModeChange: vi.fn(),
    filterQuery: '', onFilterQueryChange: vi.fn(), searchInputRef: createRef<HTMLInputElement>(),
    onHelp: vi.fn(), attributionBlind: false, lanes: new Set<LaneId>(),
    moreItems: <span data-testid="more-slot" />, followBadge: <span data-testid="follow-slot" />,
    ...over
  }
  return <TimelineToolbar {...props} />
}
const drawToolbar = (over: Partial<Props> = {}): void => {
  render(<I18nProvider><Harness {...over} /></I18nProvider>)
}
const nameOf = (el: HTMLElement): string => el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()

beforeEach(() => { try { localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ } })
afterEach(() => cleanup())

describe('the primary toolbar', () => {
  it('holds exactly range, zoom, the attribution status, the legend and 更多 as controls', () => {
    drawToolbar({ attributionBlind: true, lanes: new Set(EIGHT) })
    const row = screen.getByTestId('timeline-toolbar-row')
    const controls = within(row).getAllByRole('button').map(nameOf)
    expect(controls).toEqual([
      'timeline-range-last1h', 'timeline-range-all', 'timeline-range-custom',
      EN['timeline.zoomOut'], EN['timeline.zoomIn'],
      'timeline-attribution-details', 'timeline-legend-button', 'timeline-more-menu'
    ])
    // Live / back-to-latest is the panel's slot, drawn in the same row.
    expect(within(row).getByTestId('follow-slot')).toBeTruthy()
  })

  it('moves the mode, 搜尋區間, 重設全貌 and help into 更多, each with its shortcut', () => {
    const onHelp = vi.fn(); const onResetZoom = vi.fn()
    drawToolbar({ onHelp, onResetZoom })
    for (const id of ['timeline-mode-standard', 'timeline-mode-lanes', 'timeline-search-toggle', 'timeline-zoom-reset', 'timeline-help-open']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.queryByTestId('timeline-open-activity')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByTestId('timeline-mode-standard').getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByTestId('timeline-mode-lanes').getAttribute('aria-checked')).toBe('false')
    expect(within(menu).getByTestId('timeline-search-toggle').getAttribute('aria-keyshortcuts')).toBe('/')
    expect(within(menu).getByTestId('timeline-zoom-reset').getAttribute('aria-keyshortcuts')).toBe('0')
    expect(within(menu).getByTestId('timeline-help-open').getAttribute('aria-keyshortcuts')).toBe('?')
    // The panel's own toggles are in the same menu.
    expect(within(menu).getByTestId('more-slot')).toBeTruthy()
    fireEvent.click(within(menu).getByTestId('timeline-help-open'))
    expect(onHelp).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    fireEvent.click(screen.getByTestId('timeline-zoom-reset'))
    expect(onResetZoom).toHaveBeenCalledTimes(1)
  })

  it('更多 closes on Escape and gives focus back to its button', () => {
    drawToolbar()
    const button = screen.getByTestId('timeline-more-menu')
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByTestId('timeline-zoom-reset'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('shows the anchor only when one is set', () => {
    drawToolbar()
    expect(screen.queryByTestId('timeline-anchor')).toBeNull()
    cleanup()
    drawToolbar({ anchorTs: T0 })
    expect(screen.getByTestId('timeline-anchor')).toBeTruthy()
  })
})

describe('the attribution status', () => {
  it('is a role=status warning whose 詳情 holds the full explanation, and Escape returns focus', () => {
    drawToolbar({ attributionBlind: true })
    const status = screen.getByTestId('timeline-attribution-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain(EN['timeline.attribution.status'])
    // Warning tone, never the neutral text colours.
    expect(status.className).toContain('text-redlog-warn')
    expect(status.className).not.toMatch(/text-redlog-text(-dim|-faint)?\b/)
    expect(screen.queryByTestId('log-attribution-blind')).toBeNull()
    const details = screen.getByTestId('timeline-attribution-details')
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('log-attribution-blind').textContent).toContain(EN['timeline.fold.blind'])
    fireEvent.keyDown(screen.getByTestId('timeline-attribution-panel'), { key: 'Escape' })
    expect(screen.queryByTestId('log-attribution-blind')).toBeNull()
    expect(document.activeElement).toBe(details)
  })

  it('is absent while the join has answered or nothing was asked', () => {
    drawToolbar({ attributionBlind: false })
    expect(screen.queryByTestId('timeline-attribution-status')).toBeNull()
  })
})

describe('the legend popover', () => {
  it('lists the eight types with glyph and name, closes on Escape, and returns focus', () => {
    drawToolbar({ lanes: new Set(EIGHT) })
    const button = screen.getByTestId('timeline-legend-button')
    expect(button.textContent).toBe(EN['timeline.legend.button'])
    fireEvent.click(button)
    const panel = screen.getByTestId('log-lane-legend')
    expect(document.activeElement).toBe(panel)
    const items = [...panel.querySelectorAll('li')]
    expect(items).toHaveLength(8)
    for (const li of items) expect(li.querySelector('[aria-hidden="true"]')?.textContent).toBeTruthy()
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByTestId('log-lane-legend')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})

describe('the mounted panel', () => {
  let b: TimelineBridge
  const mount = (): void => {
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
  }
  const setAttribution = (attempted: number, resolved: number): void => {
    ;(window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events.attributionStats =
      async () => ({ attempted, resolved })
  }
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0), makeEvent('e2', T0 + 60_000, 'dns')]))
  })

  it('says the event count once', async () => {
    mount()
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('timeline-range-status').textContent).toBe('2 events loaded'))
    expect(screen.getAllByTestId('timeline-range-status')).toHaveLength(1)
    expect(screen.queryByTestId('rail-count')).toBeNull()
    expect(screen.getAllByText(/\b2 events\b/)).toHaveLength(1)
  })

  it('shows the attribution status only when traffic was attempted and none resolved', async () => {
    setAttribution(3, 0)
    mount()
    expect(await screen.findByTestId('timeline-attribution-status')).toBeTruthy()
    cleanup()
    setAttribution(3, 1)
    mount()
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    expect(screen.queryByTestId('timeline-attribution-status')).toBeNull()
    cleanup()
    setAttribution(0, 0)
    mount()
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    expect(screen.queryByTestId('timeline-attribution-status')).toBeNull()
  })

  it('names each dot\'s type on hover (title) and to the keyboard (accessible name)', async () => {
    mount()
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBeGreaterThan(0))
    const dots = [...document.querySelectorAll('[data-timeline-event]')] as HTMLElement[]
    const shellDot = dots.find((d) => d.getAttribute('aria-label')?.includes('cmd e1'))
    expect(shellDot).toBeTruthy()
    expect(shellDot!.getAttribute('aria-label')).toContain(EN['timeline.shell'])
    expect(shellDot!.getAttribute('title')).toContain(EN['timeline.shell'])
    // And a rail card carries its type in visible text.
    const cards = screen.getAllByTestId('rail-card-tag').map((c) => c.textContent ?? '')
    expect(cards.some((c) => c.includes(EN['timeline.shell']))).toBe(true)
  })

  it('keeps the shortcuts of the moved controls: / focuses the highlight, ? opens help', async () => {
    mount()
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    fireEvent.keyDown(document.body, { key: '/' })
    expect(document.activeElement).toBe(screen.getByTestId('timeline-search-input'))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: '?' })
    expect(await screen.findByTestId('timeline-help')).toBeTruthy()
  })

  it('has no density caption row and names the densest stretch on its highlight', async () => {
    // A burst of eight inside one second between quiet ends: a densest run.
    const burst = Array.from({ length: 8 }, (_, i) => makeEvent(`b${i}`, T0 + 30 * 60_000 + i * 100))
    b.queryPage.mockResolvedValue(page([makeEvent('s', T0), makeEvent('m', T0 + 10 * 60_000), ...burst, makeEvent('n', T0 + 50 * 60_000), makeEvent('z', T0 + 60 * 60_000)]))
    mount()
    await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
    expect(screen.queryByTestId('minimap-span')).toBeNull()
    expect(screen.queryByText(/^Event density/)).toBeNull()
    expect(screen.queryByTestId('log-lane-legend-hint')).toBeNull()
    const dense = await screen.findByTestId('minimap-densest')
    expect(dense.getAttribute('title')).toMatch(/^Densest stretch \(/)
    expect(dense.getAttribute('aria-label')).toBe(dense.getAttribute('title'))
    expect(screen.getByTestId('timeline-minimap').contains(dense)).toBe(true)
  })
})
