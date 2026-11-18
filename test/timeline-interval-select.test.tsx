// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

const T = 1_700_000_000_000
const KEY = 'redlog-timeline-focus-event'
const pair = (id: string, start: number, end: number | null, terminal = 'a') => [
  makeEvent(`${id}s`, T + start, 'shell', { data: { subtype: 'command_start', terminalId: terminal, command_id: id, command: `command ${id}`, shell: 'zsh' } }),
  ...end === null ? [] : [makeEvent(`${id}e`, T + end, 'shell', { data: { subtype: 'command_end', terminalId: terminal, command_id: id, command: `command ${id}`, shell: 'zsh', exit_code: 0 } })]
]
const event = () => makeEvent('m', T + 100_000, 'marker', { data: { title: 'event row' } })
const marks = () => [...document.querySelectorAll<HTMLButtonElement>('[data-timeline-interval]')]
const mark = (id: string) => marks().find((m) => m.title.includes(`command ${id}`))!
const stops = () => document.querySelectorAll('[data-timeline-event][tabindex="0"]')
const savedWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('cursor-grab') ? 2000 : 0 } })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  if (savedWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', savedWidth)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})
async function mount(rows = [...pair('a', 0, 40_000), event()], focusEventId?: string) {
  const b = installTimelineBridge({ timelineMode: 'standard' })
  b.queryPage.mockResolvedValue(page(rows))
  render(<I18nProvider><FilterProvider><TimelinePanel focusEventId={focusEventId} onDropMarker={vi.fn()} /></FilterProvider></I18nProvider>)
  await waitFor(() => expect(screen.queryAllByTestId('timeline-interval-mark').length).toBeGreaterThan(0))
  return b
}
it('click selects the end and summary; a second click deselects; no duplicate event dot (FR-007/050/051)', async () => {
  await mount()
  expect(marks(), 'intervals are real buttons').toHaveLength(1)
  expect(document.querySelectorAll('[data-timeline-event]'), 'each drawn row has one representation').toHaveLength(2)
  fireEvent.click(mark('a'), { detail: 1 })
  expect(localStorage.getItem(KEY)).toBe('ae')
  expect(screen.queryByTestId('timeline-detail-panel')).not.toBeNull()
  expect(screen.queryByTestId('timeline-detail-body')).toBeNull()
  fireEvent.click(mark('a'), { detail: 1 })
  expect(screen.queryByTestId('timeline-detail-panel')).toBeNull()
})
it('an open interval selects its start', async () => {
  await mount([...pair('a', 0, null), event()])
  fireEvent.click(mark('a'), { detail: 1 })
  expect(localStorage.getItem(KEY)).toBe('as')
})
it('any selected member lights the interval and clicking it clears that selection (FR-050/052)', async () => {
  await mount(undefined, 'as')
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('as'))
  expect(mark('a')?.getAttribute('aria-pressed')).toBe('true')
  expect(mark('a').querySelector('[data-testid="timeline-interval-selection"]')?.className).toContain('ring-2')
  expect(mark('a').querySelector<HTMLElement>('[data-testid="timeline-start-mark"]')?.style.transform).toBe('scale(1.3)')
  fireEvent.click(mark('a'), { detail: 1 })
  expect(screen.queryByTestId('timeline-detail-panel')).toBeNull()
})
it('double click opens details and Enter toggles them without empty-track zoom (FR-051/057)', async () => {
  await mount([...pair('a', 0, 40_000), event(), makeEvent('far', T + 3_600_000, 'browser')])
  const zoom = screen.getByTestId('timeline-zoom-level').textContent
  expect(mark('a'), 'interactive interval exists').toBeDefined()
  fireEvent.doubleClick(mark('a'))
  expect(screen.queryByTestId('timeline-detail-body')).not.toBeNull()
  expect(screen.getByTestId('timeline-zoom-level').textContent).toBe(zoom)
  fireEvent.keyDown(mark('a'), { key: 'Enter' })
  expect(screen.queryByTestId('timeline-detail-body')).toBeNull()
  fireEvent.keyDown(mark('a'), { key: 'Enter' })
  expect(screen.queryByTestId('timeline-detail-body')).not.toBeNull()
})
it('right click belongs to the interval, not mark-here (FR-057)', async () => {
  await mount()
  const menu = vi.fn(async () => null)
  Object.defineProperty(window.redlog, 'ui', { configurable: true, value: { contextMenu: menu } })
  expect(mark('a'), 'interactive interval exists').toBeDefined()
  fireEvent.contextMenu(mark('a'))
  expect(menu).not.toHaveBeenCalled()
})
it('release after a pan does not select or clear an interval', async () => {
  await mount()
  expect(mark('a'), 'interactive interval exists').toBeDefined()
  fireEvent.click(mark('a'), { detail: 1 })
  fireEvent.mouseDown(mark('a'), { button: 0, clientX: 100 })
  fireEvent.mouseMove(window, { clientX: 160 })
  fireEvent.mouseUp(window, { clientX: 160 })
  fireEvent.click(mark('a'), { detail: 1 })
  expect(localStorage.getItem(KEY)).toBe('ae')
  expect(screen.queryByTestId('timeline-detail-panel')).not.toBeNull()
})
it('arrows cross rows by selection time, option stays in-row, up/down use nearest time (FR-053)', async () => {
  await mount([...pair('a', 0, 40_000), ...pair('b', 150_000, 200_000), ...pair('c', 50_000, 80_000, 'b'), event()])
  expect(mark('a'), 'interactive interval exists').toBeDefined()
  fireEvent.click(mark('a'), { detail: 1 })
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(localStorage.getItem(KEY)).toBe('ce')
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(localStorage.getItem(KEY)).toBe('m')
  fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(localStorage.getItem(KEY)).toBe('ce')
  fireEvent.keyDown(window, { key: 'ArrowUp' }); expect(localStorage.getItem(KEY)).toBe('ae')
  fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true }); expect(localStorage.getItem(KEY)).toBe('be')
  fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true }); expect(localStorage.getItem(KEY)).toBe('ae')
  fireEvent.keyDown(window, { key: 'ArrowDown' }); expect(localStorage.getItem(KEY)).toBe('ce')
  fireEvent.keyDown(window, { key: 'Home' }); expect(localStorage.getItem(KEY)).toBe('ae')
  fireEvent.keyDown(window, { key: 'End' }); expect(localStorage.getItem(KEY)).toBe('be')
})
it('there is one tab stop, including an all-interval track, and keyboard focus follows selection', async () => {
  await mount([...pair('a', 0, 40_000), ...pair('b', 150_000, 200_000)])
  expect(stops(), 'one initial interval tab stop').toHaveLength(1)
  ;(stops()[0] as HTMLElement).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('ae'))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('be'))
  expect(stops()).toHaveLength(1)
  expect(document.activeElement).toBe(mark('b'))
})
it('walking to a hidden row scrolls both axes without changing zoom (FR-054)', async () => {
  await mount(Array.from({ length: 6 }, (_, i) => pair(String(i), i * 100_000, i * 100_000 + 40_000, String(i))).flat())
  const outer = screen.getByTestId('timeline-lane-scroll')
  const scroller = outer.firstElementChild as HTMLElement
  Object.defineProperty(outer, 'clientHeight', { configurable: true, value: 200 })
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 300 })
  const zoom = screen.getByTestId('timeline-zoom-level').textContent
  fireEvent.keyDown(window, { key: 'Home' })
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('0e'))
  expect(outer.scrollTop, 'hidden terminal row scrolls into view').toBeGreaterThan(0)
  expect(mark('0')).toBeDefined()
  fireEvent.keyDown(window, { key: 'End' })
  expect(scroller.scrollLeft, 'off-screen time scrolls into view').toBeGreaterThan(0)
  expect(screen.getByTestId('timeline-zoom-level').textContent).toBe(zoom)
})
it('a count opens the existing list of selection rows capped at fifty (FR-045)', async () => {
  await mount([...Array.from({ length: 55 }, (_, i) => pair(String(i), 0, 1000)).flat(), event()])
  expect(marks(), 'one interactive count').toHaveLength(1)
  fireEvent.click(marks()[0])
  const popup = document.querySelector('[data-timeline-popup]')!
  expect(popup, 'count opens the cluster list').not.toBeNull()
  expect(popup.textContent).toContain('5 more')
  const items = popup.querySelectorAll('button')
  expect(items).toHaveLength(51)
  fireEvent.click(items[1])
  expect(localStorage.getItem(KEY)?.endsWith('e')).toBe(true)
})

it('a count alone is the initial track Tab stop and opens from Enter', async () => {
  await mount([...pair('a', 0, 1000), ...pair('b', 0, 1000)])
  expect(stops()).toHaveLength(1)
  expect(stops()[0]).toBe(marks()[0])
  fireEvent.keyDown(stops()[0], { key: 'Enter' })
  expect(document.querySelector('[data-timeline-popup]')).not.toBeNull()
})
it('FR-007: duplicate starts, open and end-only commands each have exactly one representation', async () => {
  const rows = [...pair('a', 0, 40_000), ...pair('b', 100_000, null),
    ...pair('c', 200_000, 240_000).slice(1), event()]
  rows.push({ ...rows[0], id: 'duplicate-start', timestamp: T + 1 })
  await mount(rows)
  expect(marks()).toHaveLength(3)
  expect(document.querySelectorAll('[data-timeline-event]')).toHaveLength(4)
  expect(document.querySelectorAll('[data-timeline-event]:not([data-timeline-interval])')).toHaveLength(1)
})
it('walking from a selected folded start continues from its end position', async () => {
  await mount([...pair('a', 0, 40_000), event()], 'as')
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('as'))
  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(localStorage.getItem(KEY)).toBe('m')
})

it('duplicate open starts are one keyboard stop', async () => {
  const rows = [...pair('a', 0, null), event()]
  rows.push({ ...rows[0], id: 'duplicate-start', timestamp: T + 1 })
  await mount(rows)
  expect(marks()).toHaveLength(1)
  fireEvent.click(marks()[0], { detail: 1 })
  expect(localStorage.getItem(KEY)).toBe('as')
  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(localStorage.getItem(KEY)).toBe('m')
})
it('a real double click from an externally selected start opens the selection row', async () => {
  await mount(undefined, 'as')
  await waitFor(() => expect(localStorage.getItem(KEY)).toBe('as'))
  fireEvent.click(mark('a'), { detail: 1 })
  fireEvent.click(mark('a'), { detail: 2 })
  fireEvent.doubleClick(mark('a'))
  expect(localStorage.getItem(KEY)).toBe('ae')
  expect(screen.queryByTestId('timeline-detail-body')).not.toBeNull()
})
