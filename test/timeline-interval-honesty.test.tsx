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
  // Pointer input is blocked by CSS, as on the event row. Keyboard walking
  // still reaches dimmed marks and Enter must use the same detail contract.
  mark('a').focus()
  fireEvent.keyDown(mark('a'), { key: 'Home' })
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(mark('b'))
  expect(mark('b').tabIndex).toBe(0)
  fireEvent.keyDown(mark('b'), { key: 'Enter' })
  expect(screen.queryByTestId('timeline-detail-body'), 'N2: Enter opens the walked-to dimmed interval').not.toBeNull()
  fireEvent.keyDown(mark('b'), { key: 'Enter' })
  expect(screen.queryByTestId('timeline-detail-body')).toBeNull()
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

it('N1: verify break on an open start stays on the start mark', async () => {
  noteOpenProject('p1')
  setLastVerifyResult({ ok: false, brokenAtEventId: 'as' }, { projectId: 'p1' })
  await mount([pair('a', 0)[0]])
  const badge = mark('a').querySelector<HTMLElement>('[data-interval-badge]')
  expect(badge?.textContent, 'N1: open start retains verify-broken badge').toBe('⛓️‍💥')
  const start = mark('a').querySelector<HTMLElement>('[data-testid="timeline-start-mark"]')!
  expect(parseFloat(badge!.style.left)).toBe(parseFloat(start.style.left) + 8)
  expect(mark('a').title).toContain('full-chain verify broke here')
})
it('N1: finished commands collect start badges and deduplicate by key in row order', async () => {
  const rows = pair('a', 0, { _clock_anomaly: { reason: 'same clock reason' }, recovered: true })
  rows[0].data = { ...rows[0].data as object, _clock_anomaly: { reason: 'same clock reason' } }
  await mount(rows)
  expect(mark('a').querySelector('[data-interval-badge]')?.textContent, 'N1: start clock is promoted above end recovery').toBe('⚠')
  expect(mark('a').title.match(/same clock reason/g), 'N1: duplicate clock badge reason appears once').toHaveLength(1)
  expect(mark('a').title).toContain('recovered from orphaned session')
  expect(mark('a').querySelector('[data-interval-badge]')?.getAttribute('title')?.match(/same clock reason/g)).toHaveLength(1)
})
it('N1: a finished command carries a clock badge found only on its start', async () => {
  const rows = pair('a', 0)
  rows[0].data = { ...rows[0].data as object, _clock_anomaly: { reason: 'start clock skew' } }
  await mount(rows)
  expect(mark('a').title, 'N1: start-only clock reason survives pairing').toContain('start clock skew')
  expect(mark('a').querySelector('[data-interval-badge]')?.textContent).toBe('⚠')
  const badge = mark('a').querySelector<HTMLElement>('[data-interval-badge]')!
  const end = mark('a').querySelector<HTMLElement>('[data-end-shape]')!
  expect(parseFloat(badge.style.left), 'N1: a finished start badge is drawn at the end').toBe(parseFloat(end.style.left) + 6)
})
it('N3: counts promote clock above an earlier recovery badge', async () => {
  await mount([...pair('a', 0, { recovered: true }), ...pair('b', 1, { _clock_anomaly: { reason: 'count clock skew' } })])
  expect(marks()).toHaveLength(1)
  expect(marks()[0].querySelector('[data-interval-badge]')?.textContent, 'N3: count promotes clock above recovery').toBe('⚠')
})

it('N2: dimmed dots and intervals share pointer handlers and Enter while CSS excludes pointer input', async () => {
  const b = await mount([...pair('a', 0), makeEvent('m', T + 50_000, 'marker', { data: { title: 'note' } }), ...pair('b', 100_000)])
  b.matchIds.mockImplementation(async req => req.parsed ? ['as'] : req.ids)
  fireEvent.change(screen.getByTestId('timeline-search-input'), { target: { value: 'command a' } })
  await waitFor(() => expect(mark('b').getAttribute('aria-disabled')).toBe('true'))
  const dot = document.querySelector<HTMLButtonElement>('[data-timeline-event]:not([data-timeline-interval])')!
  for (const target of [dot, mark('b')]) {
    expect(target.style.pointerEvents).toBe('none')
    expect(target.getAttribute('aria-disabled')).toBe('true')
    // fireEvent deliberately dispatches through pointer-events:none; compare
    // the handlers too, not jsdom's nonexistent pointer hit testing.
    fireEvent.click(target, { detail: 1 })
    expect(screen.queryByTestId('timeline-detail-panel')).not.toBeNull()
    expect(screen.queryByTestId('timeline-detail-body')).toBeNull()
    fireEvent.doubleClick(target)
    expect(screen.queryByTestId('timeline-detail-body')).not.toBeNull()
    fireEvent.keyDown(target, { key: 'Enter' })
    expect(screen.queryByTestId('timeline-detail-body')).toBeNull()
    fireEvent.click(target, { detail: 1 })
    expect(screen.queryByTestId('timeline-detail-panel')).toBeNull()
  }
})
it('N1: a superseded command keeps the clock badge at its start', async () => {
  const rows = [pair('a', 0)[0], ...pair('b', 100_000)]
  rows[0].data = { ...rows[0].data as object, _clock_anomaly: { reason: 'superseded start clock' } }
  await mount(rows)
  const start = mark('a').querySelector<HTMLElement>('[data-testid="timeline-start-mark"]')!
  const badge = mark('a').querySelector<HTMLElement>('[data-interval-badge]')!
  expect(badge.textContent).toBe('⚠')
  expect(parseFloat(badge.style.left)).toBe(parseFloat(start.style.left) + 8)
})

it('N1: one badge key can explain distinct start and end reasons without drawing twice', async () => {
  const rows = pair('a', 0, { _clock_anomaly: { reason: 'end clock reason' } })
  rows[0].data = { ...rows[0].data as object, _clock_anomaly: { reason: 'start clock reason' } }
  await mount(rows)
  expect(mark('a').querySelectorAll('[data-interval-badge]')).toHaveLength(1)
  expect(mark('a').title, 'N1: every distinct member badge reason survives').toContain('end clock reason')
  expect(mark('a').title.indexOf('start clock reason')).toBeLessThan(mark('a').title.indexOf('end clock reason'))
})
