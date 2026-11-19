// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { noteOpenProject, setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

const T = 1_700_000_000_000
const pair = (id: string, start: number, extra = {}) => [
  makeEvent(`${id}s`, T + start, 'shell', { data: { subtype: 'command_start', terminalId: 't', command_id: id, command: `command ${id}`, shell: 'zsh' } }),
  makeEvent(`${id}e`, T + start + 1000, 'shell', { data: { subtype: 'command_end', terminalId: 't', command_id: id, command: `command ${id}`, shell: 'zsh', exit_code: 0, ...extra } })
]
const marks = () => [...document.querySelectorAll<HTMLButtonElement>('[data-timeline-interval]')]
const mark = (id: string) => marks().find(m => m.title.includes(`command ${id}`))!
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('cursor-grab') ? 2000 : 0 } })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); setLastVerifyResult(null); noteOpenProject(null)
  if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
})
async function mount(rows: ReturnType<typeof makeEvent>[], focusEventId?: string) {
  const b = installTimelineBridge({ timelineMode: 'standard' })
  b.queryPage.mockResolvedValue(page(rows))
  render(<I18nProvider><FilterProvider><TimelinePanel focusEventId={focusEventId} /></FilterProvider></I18nProvider>)
  await waitFor(() => expect(marks().length).toBeGreaterThan(0))
  return b
}
it('F3: search matching only a raw start lights that interval and disables the others', async () => {
  const b = await mount([...pair('a', 0), ...pair('b', 100_000), ...pair('c', 200_000)])
  b.matchIds.mockImplementation(async req => req.parsed ? ['as'] : req.ids)
  fireEvent.change(screen.getByTestId('timeline-search-input'), { target: { value: 'command a' } })
  await waitFor(() => expect(mark('b').getAttribute('aria-disabled'), 'F3: nonmatching interval is disabled').toBe('true'))
  expect(mark('a').getAttribute('aria-disabled')).toBeNull()
  expect(mark('b').style.opacity).toBe('0.15')
  expect(mark('b').style.pointerEvents).toBe('none')
  fireEvent.click(mark('b'))
  fireEvent.doubleClick(mark('b'))
  fireEvent.keyDown(mark('b'), { key: 'Enter' })
  expect(screen.queryByTestId('timeline-detail-panel'), 'F3: dimmed interval cannot select or open').toBeNull()
})
it('F3: focus chain dims nonmembers and counts light when any member matches', async () => {
  const rows = [...pair('a', 0), ...pair('b', 1), ...pair('c', 200_000)]
  await mount(rows, 'ae')
  const bridge = window.redlog.events
  vi.spyOn(bridge, 'causalChain').mockResolvedValue({ anchorFound: true, events: [rows[0], rows[1]], edges: [], truncated: false, unavailableCauseIds: [] } as never)
  fireEvent.keyDown(window, { key: 'f' })
  await waitFor(() => expect(mark('c').getAttribute('aria-disabled'), 'F3: chain dims unrelated interval').toBe('true'))
  expect(mark('a').getAttribute('aria-disabled')).toBeNull()
})
it('F3: end marks retain verify, recovered, spool badges and output texture', async () => {
  noteOpenProject('p1')
  setLastVerifyResult({ ok: false, brokenAtEventId: 'ae' }, { projectId: 'p1' })
  await mount([...pair('a', 0, { stdout: 'hello' }), ...pair('b', 100_000, { recovered: true }), ...pair('c', 200_000, { _ingest: { door: 'handoff', terminal: 't' } })])
  const a = mark('a')
  expect(a.querySelector('[data-interval-badge]')?.textContent, 'F3: verify-broken icon survives on end mark').toBe('⛓️‍💥')
  expect(a.title).toContain('full-chain verify broke here')
  expect(mark('b').title).toContain('recovered from orphaned session')
  expect(mark('b').querySelector('[data-interval-badge]')?.textContent).toBe('🔄')
  expect(mark('c').title).toContain('recovered from the handoff spool')
  expect(mark('c').querySelector('[data-interval-badge]')?.textContent).toBe('📮')
  expect(a.querySelector('[data-interval-io]'), 'F3: end mark retains ioMark').not.toBeNull()
})
it('F3: counts show the most severe member badge even after the first member', async () => {
  noteOpenProject('p1')
  setLastVerifyResult({ ok: false, brokenAtEventId: 'be' }, { projectId: 'p1' })
  await mount([...pair('a', 0, { recovered: true }), ...pair('b', 1)])
  expect(marks()).toHaveLength(1)
  expect(marks()[0].querySelector('[data-interval-badge]')?.textContent, 'F3: count promotes verify failure above recovery').toBe('⛓️‍💥')
})
