// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ActivityAround } from '../src/renderer/src/components/ActivityAround'
import { I18nProvider } from '../src/renderer/src/i18n'
import { setDisplayZone } from '../src/renderer/src/lib/time'
import type { ActivitySummary } from '../src/core/activity-contract'
import type { EventQueryOptions, RedLogEvent } from '../src/core/db/events'

beforeEach(() => setDisplayZone('utc'))
afterEach(cleanup)

const T0 = Date.UTC(2026, 10, 9, 15, 0, 0)
const ev = (id: string, offset: number, agentType: string, data: Record<string, unknown>, extra: Partial<RedLogEvent> = {}): RedLogEvent =>
  ({ id, timestamp: T0 + offset, engagementId: 'p', sessionId: 'capture', operatorId: 'op', agentType, hostname: 'h', data, ...extra } as unknown as RedLogEvent)
const anchor = ev('anchor', 0, 'shell', { shell: 'bash', terminalId: 'term-1', subtype: 'command_end', command: 'nmap -sV 10.0.0.5', command_id: 'c1' })
const item = (over: Partial<ActivitySummary> = {}): ActivitySummary =>
  ({ id: 'act1', anchor, sourcePreview: { ids: ['anchor'], hasMore: false }, ...over } as unknown as ActivitySummary)

type Query = (opts: EventQueryOptions) => Promise<RedLogEvent[]>
function bridge(query: Query, projects: string[] = ['p']): void {
  let reads = 0
  ;(window as any).redlog = {
    config: { get: async () => ({ engagement: { id: projects[Math.min(reads++, projects.length - 1)] } }) },
    events: { query }
  }
}
const mount = (it_: ActivitySummary = item(), projectId = 'p') => render(<I18nProvider><ActivityAround item={it_} projectId={projectId} /></I18nProvider>)
const toggle = (): HTMLElement => screen.getByTestId('activity-around-toggle')
const rows = (): HTMLElement[] => screen.queryAllByTestId('activity-around-event')

it('reads nothing until asked, then lists both sides in clock order with the offset from the anchor', async () => {
  const query = vi.fn<Query>(async opts => opts.order === 'oldest'
    ? [ev('anchor', 0, 'shell', {}), ev('after1', 3_200, 'scanner', { subtype: 'http_request_start', flow_id: 'f9', method: 'GET', url: 'https://t.example/' })]
    : [ev('before1', -1_000, 'agent', { subtype: 'assistant_message', agent: 'codex', session_id: 's', full: 'thinking' }), ev('before2', -9_000, 'marker', { title: 'note' })])
  bridge(query)
  mount()
  expect(query).not.toHaveBeenCalled()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle())
  await waitFor(() => expect(rows()).toHaveLength(3))
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(query).toHaveBeenCalledTimes(2)
  expect(rows().map(row => within(row).getByTestId('activity-around-relation').textContent)).toEqual(['Nearby in time', 'Nearby in time', 'Nearby in time'])
  expect(rows().map(row => row.querySelector('time')!.textContent)).toEqual(['−9.0 s', '−1.0 s', '+3.2 s'])
  expect(rows()[1].textContent).toContain('Codex')
  // The operation's own events are not "around" it, and the marker line sits between the sides.
  expect(screen.getByTestId('activity-around').textContent).not.toContain('nmap')
  expect(screen.getByTestId('activity-around').querySelector('[aria-current="true"]')!.textContent).toBe('This operation')
})

it('names a relation only when a shared key proves it, and says nearby in time otherwise', async () => {
  const query = vi.fn<Query>(async opts => opts.order === 'oldest'
    ? [ev('same-cmd', 500, 'shell', { shell: 'bash', terminalId: 'term-1', subtype: 'command_output', command_id: 'c1' }),
      ev('same-term', 900, 'shell', { shell: 'bash', terminalId: 'term-1', subtype: 'command_end', command_id: 'c2' }),
      ev('other-term', 1_200, 'shell', { shell: 'bash', terminalId: 'term-2', subtype: 'command_end', command_id: 'c1' })]
    : [])
  bridge(query)
  mount()
  fireEvent.click(toggle())
  await waitFor(() => expect(rows()).toHaveLength(3))
  expect(rows().map(row => row.getAttribute('data-relation'))).toEqual(['command', 'session', 'time'])
  expect(rows().map(row => within(row).getByTestId('activity-around-relation').textContent)).toEqual(['Same command', 'Same session', 'Nearby in time'])
})

it('says so when the window is empty, and does not draw the operation marker alone', async () => {
  bridge(async opts => opts.order === 'oldest' ? [anchor] : [])
  mount()
  fireEvent.click(toggle())
  expect((await screen.findByTestId('activity-around-empty')).textContent).toBe('No other events within 5 minutes either side')
  expect(rows()).toHaveLength(0)
  expect(screen.getByTestId('activity-around').querySelector('[aria-current]')).toBeNull()
})

it('keeps to five a side and says when the window holds more', async () => {
  const before = Array.from({ length: 6 }, (_, i) => ev(`b${i}`, -(i + 1) * 1_000, 'marker', { title: `b${i}` }))
  const after = Array.from({ length: 6 }, (_, i) => ev(`f${i}`, (i + 1) * 1_000, 'marker', { title: `f${i}` }))
  bridge(async opts => opts.order === 'oldest' ? after : before)
  mount()
  fireEvent.click(toggle())
  await waitFor(() => expect(rows()).toHaveLength(10))
  expect(screen.getByTestId('activity-around-more').textContent).toContain('Nearest 5')
})

it('does not read a reply as this project\'s neighbours once another project is open', async () => {
  const query = vi.fn<Query>(async () => [ev('leak', 100, 'marker', { title: 'foreign' }, { engagementId: 'p' })])
  // The project is `p` when the read starts and `q` by the time the answer is back.
  bridge(query, ['p', 'q'])
  mount()
  fireEvent.click(toggle())
  expect((await screen.findByRole('alert')).textContent).toContain('Source content is unavailable')
  expect(rows()).toHaveLength(0)
  expect(screen.queryByTestId('activity-around-empty')).toBeNull()
})

it('refuses events stamped with another project', async () => {
  bridge(async () => [ev('leak', 100, 'marker', { title: 'foreign' }, { engagementId: 'other' })])
  mount()
  fireEvent.click(toggle())
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(rows()).toHaveLength(0)
})

it('drops a late reply for an operation that is no longer the one shown', async () => {
  const pending: Array<(events: RedLogEvent[]) => void> = []
  const query = vi.fn<Query>(opts => new Promise(resolve => { pending.push(events => resolve(opts.order === 'oldest' ? events : [])) }))
  bridge(query)
  const first = item()
  const second = item({ id: 'act2', anchor: ev('anchor2', 60_000, 'shell', { shell: 'bash', terminalId: 'term-1', command_id: 'c9' }), sourcePreview: { ids: ['anchor2'], hasMore: false } })
  const view = render(<I18nProvider><ActivityAround item={first} projectId="p" /></I18nProvider>)
  fireEvent.click(toggle())
  await waitFor(() => expect(pending).toHaveLength(2))
  view.rerender(<I18nProvider><ActivityAround item={second} projectId="p" /></I18nProvider>)
  await waitFor(() => expect(pending).toHaveLength(4))
  // The reply for the first operation arrives after the second was asked for.
  await act(async () => { pending[0]([]); pending[1]([ev('stale', 100, 'marker', { title: 'stale-row' })]) })
  expect(screen.queryByText('stale-row')).toBeNull()
  await act(async () => { pending[2]([]); pending[3]([ev('fresh', 61_000, 'marker', { title: 'fresh-row' })]) })
  await waitFor(() => expect(rows()).toHaveLength(1))
  expect(rows()[0].textContent).toContain('fresh-row')
  expect(screen.queryByText('stale-row')).toBeNull()
})

it('keeps the personal and scope filters of the list it sits in', async () => {
  const query = vi.fn<Query>(async () => [])
  bridge(query)
  render(<I18nProvider><ActivityAround item={item()} projectId="p" scope={{ inScopeOnly: true, hidePersonal: true }} /></I18nProvider>)
  fireEvent.click(toggle())
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
  for (const [opts] of query.mock.calls) expect(opts).toMatchObject({ inScopeOnly: true, hidePersonal: true, excludeHousekeeping: true })
  expect(query.mock.calls.every(([opts]) => opts.agentType === undefined)).toBe(true)
})
