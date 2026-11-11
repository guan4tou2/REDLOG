// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { parseQuery } from '../src/core/query/contract'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const KEY = 'redlog-timeline-filter-query:p1'
const STORED = 'nmap'

function mount(props: { focusEventId?: string; focusTs?: number } = {}): ReturnType<typeof render> {
  return render(<I18nProvider><FilterProvider><TimelinePanel {...props} /></FilterProvider></I18nProvider>)
}
const box = (): HTMLInputElement => screen.getByTestId('timeline-search-input') as HTMLInputElement
const dots = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-event]'))
const stored = (): string | null => localStorage.getItem(KEY)
const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 200)) }) }

type Req = { ids: string[]; parsed?: unknown; filter?: unknown; excludeHousekeeping?: boolean }
// The arrival check: one id, with the stored query parsed as the box parses it.
const isArrivalCheck = (req: Req): boolean => !!req.parsed && req.ids.length === 1 && req.ids[0] === 'a'

// A stored `/` query is restored per project. Opened to focus an event, the
// Timeline keeps that query only when the focused event matches it, so a stale
// query cannot dim the row the operator jumped to — while a return visit
// (goBack also arrives with an id) keeps the operator's box.
describe('the stored Timeline query on a focus arrival', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    localStorage.setItem(KEY, STORED)
    b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page([makeEvent('a', T0), makeEvent('b', T0 - 1000, 'http')]))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('applies the stored query on a plain visit', async () => {
    mount()
    await waitFor(() => expect(box().value).toBe(STORED))
    expect(b.matchIds.mock.calls.some((c) => isArrivalCheck(c[0] as Req))).toBe(false)
  })

  it('applies the stored query when the focused event matches it', async () => {
    b.matchIds.mockImplementation(async (req: Req) => req.ids)
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(box().value).toBe(STORED))
    const call = b.matchIds.mock.calls.map((c) => c[0] as Req).find(isArrivalCheck)
    expect(call).toMatchObject({ ids: ['a'], excludeHousekeeping: true })
    expect(call?.parsed).toEqual((parseQuery(STORED) as { parsed: unknown }).parsed)
    expect(call?.filter).toBeDefined()
    expect(stored()).toBe(STORED)
  })

  it('leaves the box empty, and the stored query in place, when the focused event does not match', async () => {
    b.matchIds.mockImplementation(async (req: Req) => (req.parsed ? [] : req.ids))
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(b.matchIds.mock.calls.some((c) => isArrivalCheck(c[0] as Req))).toBe(true))
    await waitFor(() => expect(dots().length).toBeGreaterThan(0))
    await flush()
    expect(box().value).toBe('')
    expect(stored()).toBe(STORED)
  })

  it('stores what the operator types after a non-matching arrival', async () => {
    b.matchIds.mockImplementation(async (req: Req) => (req.parsed ? [] : req.ids))
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(b.matchIds.mock.calls.some((c) => isArrivalCheck(c[0] as Req))).toBe(true))
    await flush()
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: 'curl' } })
    await waitFor(() => expect(stored()).toBe('curl'))
    expect(box().value).toBe('curl')
  })

  it('leaves the box empty, and the stored query in place, when the check fails', async () => {
    b.matchIds.mockImplementation(async (req: Req) => {
      if (req.parsed) throw new Error('ipc down')
      return req.ids
    })
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(b.matchIds.mock.calls.some((c) => isArrivalCheck(c[0] as Req))).toBe(true))
    await flush()
    expect(box().value).toBe('')
    expect(stored()).toBe(STORED)
  })

  it('leaves the box empty, and the stored query in place, on an arrival by time alone', async () => {
    mount({ focusTs: T0 })
    await waitFor(() => expect(dots().length).toBeGreaterThan(0))
    await flush()
    expect(box().value).toBe('')
    expect(stored()).toBe(STORED)
    expect(b.matchIds.mock.calls.some((c) => !!(c[0] as Req).parsed)).toBe(false)
  })

  it('treats an unparsable stored query as not matching', async () => {
    localStorage.setItem(KEY, 'session:')
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(dots().length).toBeGreaterThan(0))
    await flush()
    expect(box().value).toBe('')
    expect(stored()).toBe('session:')
    expect(b.matchIds.mock.calls.some((c) => !!(c[0] as Req).parsed)).toBe(false)
  })

  it('keeps what the operator typed when the check answers late', async () => {
    const reply = deferred<string[]>()
    b.matchIds.mockImplementation(async (req: Req) => (isArrivalCheck(req) ? reply.promise : req.ids))
    mount({ focusEventId: 'a' })
    await waitFor(() => expect(b.matchIds.mock.calls.some((c) => isArrivalCheck(c[0] as Req))).toBe(true))
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: 'curl' } })
    await waitFor(() => expect(stored()).toBe('curl'))
    await act(async () => { reply.resolve(['a']) })
    await flush()
    expect(box().value).toBe('curl')
    expect(stored()).toBe('curl')
  })
})
