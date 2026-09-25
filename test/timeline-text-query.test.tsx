// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { parseQuery } from '../src/core/query/contract'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000

function mount(props: { focusEventId?: string } = {}): ReturnType<typeof render> {
  return render(<I18nProvider><FilterProvider><TimelinePanel {...props} /></FilterProvider></I18nProvider>)
}
const status = (): string => screen.getByTestId('timeline-range-status').textContent ?? ''
const box = (): HTMLInputElement => screen.getByTestId('timeline-search-input') as HTMLInputElement
const type = (text: string): void => { fireEvent.change(box(), { target: { value: text } }) }
const dots = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-event]'))
const dimmedDots = (): HTMLElement[] => dots().filter((d) => d.getAttribute('aria-disabled') === 'true')
const dotFor = (command: string): HTMLElement | undefined => dots().find((d) => d.getAttribute('aria-label')?.includes(command))
const lastCall = (fn: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  fn.mock.calls[fn.mock.calls.length - 1]?.[0] as Record<string, unknown>

// Each event on its own lane, so every one is a single dot in jsdom.
const shell = (id: string, ts: number, extra = {}): ReturnType<typeof makeEvent> =>
  makeEvent(id, ts, 'shell', { data: { subtype: 'command_end', command: `cmd ${id}` }, ...extra })

// Spec 038 US3: the Timeline's box reads its input with the query contract,
// asks the persistence layer which drawn rows match, and dims — never
// removes — the rest. It used to substring-match ten fields of the rows it
// had loaded, so `session:S1` was text and a match older than the drawn
// range simply did not exist.
describe('the Timeline filter box on the query contract', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const firstPageOnly = (items: ReturnType<typeof makeEvent>[], hasMore = false): void => {
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page(items, hasMore, hasMore ? 'c1' : null))
  }

  it('asks which drawn rows match the parsed input, and dims the others', async () => {
    firstPageOnly([shell('a', T0), shell('b', T0 - 1000)])
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) =>
      req.parsed ? ['a'] : req.ids)
    mount()
    await waitFor(() => expect(dots()).toHaveLength(2))
    type('10.0.0.5')
    await waitFor(() => expect(dimmedDots()).toHaveLength(1))
    const call = b.matchIds.mock.calls.map((c) => c[0] as Record<string, unknown>).find((c) => c.parsed)
    expect(call).toMatchObject({ excludeHousekeeping: true })
    expect(call?.parsed).toEqual(parseQuery('10.0.0.5').ok && (parseQuery('10.0.0.5') as { parsed: unknown }).parsed)
    expect((call?.ids as string[]).sort()).toEqual(['a', 'b'])
    expect(dotFor('cmd b')?.getAttribute('aria-disabled')).toBe('true')
    expect(dots()).toHaveLength(2)
  })

  it('shows how it read the input', async () => {
    firstPageOnly([shell('a', T0)])
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('session:S1 nmap')
    const strip = await screen.findByTestId('timeline-query-parse')
    expect(Array.from(strip.querySelectorAll('[data-token]')).map((el) => el.getAttribute('data-token'))).toEqual(['condition', 'text'])
  })

  it('says an unparsable input was not applied, and dims nothing', async () => {
    firstPageOnly([shell('a', T0)])
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    b.matchIds.mockClear()
    type('session:')
    await screen.findByTestId('timeline-query-unparsable')
    expect(dimmedDots()).toHaveLength(0)
    expect(b.matchIds.mock.calls.some((c) => (c[0] as { parsed?: unknown }).parsed)).toBe(false)
  })

  it('counts matches older than the drawn range from the page cursor', async () => {
    firstPageOnly([shell('a', T0)], true)
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? [] : req.ids)
    b.count.mockImplementation(async (req: { parsed?: unknown }) => req.parsed ? 3 : 10)
    b.runQuery.mockResolvedValue({ items: [shell('old', T0 - 86_400_000)], hasMore: true, nextCursor: 'q1' })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    const notice = await screen.findByTestId('timeline-earlier-matches')
    expect(notice.textContent).toContain('3 earlier')
    expect(b.count.mock.calls.map((c) => c[0]).find((r) => (r as { parsed?: unknown }).parsed)).toMatchObject({ cursor: 'c1', excludeHousekeeping: true })
    expect(lastCall(b.runQuery)).toMatchObject({ cursor: 'c1', limit: 1, excludeHousekeeping: true })
  })

  it('loads back to the nearest earlier match from the notice, and selects it', async () => {
    let calls = 0
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null; limit?: number }) => {
      if (!opts.cursor) return page([shell('a', T0)], true, 'c1')
      if (opts.limit !== 1000) return new Promise(() => {})
      calls += 1
      return calls === 1
        ? page([shell('mid', T0 - 1000)], true, 'c2')
        : page([shell('old', T0 - 86_400_000)], false, null)
    })
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) =>
      req.parsed ? req.ids.filter((id) => id === 'old') : req.ids)
    b.count.mockImplementation(async (req: { parsed?: unknown }) => req.parsed ? 1 : 3)
    b.runQuery.mockResolvedValue({ items: [shell('old', T0 - 86_400_000)], hasMore: false, nextCursor: null })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    const notice = await screen.findByTestId('timeline-earlier-matches')
    fireEvent.keyDown(notice, { key: 'Enter' })
    fireEvent.click(notice)
    await waitFor(() => expect(dotFor('cmd old')?.getAttribute('aria-pressed')).toBe('true'))
    expect(calls).toBe(2)
  })

  it('stops a load-back on Esc and keeps what it loaded', async () => {
    const hang = deferred<ReturnType<typeof page>>()
    let calls = 0
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null; limit?: number }) => {
      if (!opts.cursor) return page([shell('a', T0)], true, 'c1')
      if (opts.limit !== 1000) return new Promise(() => {})
      calls += 1
      return calls === 1 ? page([shell('mid', T0 - 1000)], true, 'c2') : hang.promise
    })
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? [] : req.ids)
    b.count.mockImplementation(async (req: { parsed?: unknown }) => req.parsed ? 1 : 3)
    b.runQuery.mockResolvedValue({ items: [shell('old', T0 - 86_400_000)], hasMore: false, nextCursor: null })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    fireEvent.click(await screen.findByTestId('timeline-earlier-matches'))
    await screen.findByTestId('timeline-loadback-progress')
    await waitFor(() => expect(dots()).toHaveLength(2))
    fireEvent.keyDown(window, { key: 'Escape' })
    await screen.findByTestId('timeline-loadback-cancelled')
    await act(async () => { hang.resolve(page([shell('old', T0 - 86_400_000)], false, null)) })
    expect(dots()).toHaveLength(2)
  })

  it('shows a failed match as a failure with retry, and dims nothing', async () => {
    firstPageOnly([shell('a', T0), shell('b', T0 - 1000)])
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => {
      if (req.parsed) throw new Error('fts: malformed')
      return req.ids
    })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(2))
    type('nmap')
    await screen.findByTestId('timeline-query-failed')
    expect(dimmedDots()).toHaveLength(0)
  })

  it('lights a marker whose amendment matched', async () => {
    const marker = makeEvent('mk', T0 - 1000, 'marker', { data: { title: 'old title', severity: 'high' } })
    const amendment = makeEvent('amd', T0, 'marker', { data: { subtype: 'amended', markerId: 'mk', title: 'new title' } })
    firstPageOnly([marker, amendment])
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? ['amd'] : req.ids)
    mount()
    await waitFor(() => expect(dots().length).toBeGreaterThan(0))
    type('new')
    await waitFor(() => expect(screen.getByTestId('timeline-match-count').textContent).toMatch(/1/))
    expect(dimmedDots()).toHaveLength(0)
  })

  it('announces the match count', async () => {
    firstPageOnly([shell('a', T0), shell('b', T0 - 1000), shell('c', T0 - 2000)])
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? ['a', 'c'] : req.ids)
    mount()
    await waitFor(() => expect(dots()).toHaveLength(3))
    type('cmd')
    const live = await screen.findByTestId('timeline-match-count')
    expect(live.getAttribute('aria-live')).toBe('polite')
    await waitFor(() => expect(live.textContent).toContain('2'))
  })

  it('reads a palette operator pick as operator:<id>, and a host as quoted text', async () => {
    firstPageOnly([shell('a', T0)])
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    act(() => { window.dispatchEvent(new CustomEvent('redlog:filter-operator', { detail: 'op-2' })) })
    await waitFor(() => expect(box().value).toBe('operator:op-2'))
    act(() => { window.dispatchEvent(new CustomEvent('redlog:filter-host', { detail: '10.0.0.5:8080' })) })
    await waitFor(() => expect(box().value).toBe('"10.0.0.5:8080"'))
  })

  it('loads back to an event opened from another view, or says it is filtered out', async () => {
    let calls = 0
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null; limit?: number }) => {
      if (!opts.cursor) return page([shell('a', T0)], true, 'c1')
      if (opts.limit !== 1000) return new Promise(() => {})
      calls += 1
      return page([shell('far', T0 - 5000)], false, null)
    })
    mount({ focusEventId: 'far' })
    await waitFor(() => expect(dotFor('cmd far')).toBeDefined())
    expect(calls).toBe(1)
    cleanup()

    b.matchIds.mockResolvedValue([])
    mount({ focusEventId: 'gone' })
    await screen.findByTestId('timeline-outside-filter')
  })

  it('dims every drawn event when the only matches are earlier', async () => {
    firstPageOnly([shell('a', T0), shell('b', T0 - 1000)], true)
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? [] : req.ids)
    b.count.mockImplementation(async (req: { parsed?: unknown }) => req.parsed ? 4 : 20)
    b.runQuery.mockResolvedValue({ items: [shell('old', T0 - 86_400_000)], hasMore: true, nextCursor: 'q1' })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(2))
    type('nmap')
    await screen.findByTestId('timeline-earlier-matches')
    await waitFor(() => expect(dimmedDots()).toHaveLength(2))
  })

  it('lights the drawn end of a command whose start matched', async () => {
    const start = makeEvent('st', T0 - 2000, 'shell', { data: { subtype: 'command_start', command: 'nmap -sV x', pid: 7 } })
    const end = makeEvent('en', T0 - 1000, 'shell', { data: { subtype: 'command_end', command: 'nmap -sV x', pid: 7, exit_code: 0 } })
    const other = shell('z', T0)
    firstPageOnly([start, end, other])
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? ['st'] : req.ids)
    mount()
    await waitFor(() => expect(dots()).toHaveLength(2))
    type('sV')
    await waitFor(() => expect(dimmedDots()).toHaveLength(1))
    expect(dotFor('cmd z')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('shows that it is matching while the check is in flight', async () => {
    firstPageOnly([shell('a', T0)])
    const pending = deferred<string[]>()
    b.matchIds.mockImplementation((req: { ids: string[]; parsed?: unknown }) => req.parsed ? pending.promise : Promise.resolve(req.ids))
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    await screen.findByTestId('timeline-query-matching')
    await act(async () => { pending.resolve(['a']) })
    await waitFor(() => expect(screen.queryByTestId('timeline-query-matching')).toBeNull())
  })

  it('offers retry when a load-back page fails, keeping what it loaded', async () => {
    let calls = 0
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null; limit?: number }) => {
      if (!opts.cursor) return page([shell('a', T0)], true, 'c1')
      if (opts.limit !== 1000) return new Promise(() => {})
      calls += 1
      if (calls === 1) return page([shell('mid', T0 - 1000)], true, 'c2')
      throw new Error('disk I/O error')
    })
    b.matchIds.mockImplementation(async (req: { ids: string[]; parsed?: unknown }) => req.parsed ? [] : req.ids)
    b.count.mockImplementation(async (req: { parsed?: unknown }) => req.parsed ? 1 : 3)
    b.runQuery.mockResolvedValue({ items: [shell('old', T0 - 86_400_000)], hasMore: false, nextCursor: null })
    mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    fireEvent.click(await screen.findByTestId('timeline-earlier-matches'))
    const failed = await screen.findByTestId('timeline-loadback-failed')
    expect(failed.textContent).toContain('Retry')
    expect(dots()).toHaveLength(2)
  })

  it('keeps the box input for the project across a remount', async () => {
    firstPageOnly([shell('a', T0)])
    const first = mount()
    await waitFor(() => expect(dots()).toHaveLength(1))
    type('nmap')
    first.unmount()
    mount()
    await waitFor(() => expect(box().value).toBe('nmap'))
  })
})
