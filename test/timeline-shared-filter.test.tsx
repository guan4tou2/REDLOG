// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { getViewExport } from '../src/renderer/src/lib/exportScope'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

let filterApi: ReturnType<typeof useSharedFilter>
function Probe(): null { filterApi = useSharedFilter(); return null }

function mount(props: { focusEventId?: string } = {}): void {
  render(<I18nProvider><FilterProvider><Probe /><TimelinePanel {...props} /></FilterProvider></I18nProvider>)
}

const lastCall = (fn: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  fn.mock.calls[fn.mock.calls.length - 1]?.[0] as Record<string, unknown>

const status = (): string => screen.getByTestId('timeline-range-status').textContent ?? ''

const T0 = 1_700_000_000_000

// jsdom has no width, so the track sits at its old edge and the panel asks
// for the next page at once, as it does for a range that fits on screen.
// These tests look at the first page, so a cursor request stays in flight.
const firstPageOnly = (b: TimelineBridge, first: ReturnType<typeof page>): void => {
  b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) => opts.cursor ? new Promise(() => {}) : first)
}
// Select the one drawn event, as a click on its dot does.
const selectOnlyDot = (): void => {
  const dot = document.querySelector('[data-timeline-event]')
  if (!dot) throw new Error('no event dot drawn')
  fireEvent.click(dot)
}

// Spec 033 US1: the Timeline draws what the shared filter admits, over the
// whole project, read where the events are stored, and says when it has
// drawn only part of it. It used to read the newest 200 rows unfiltered and
// then ignore Type and Time outright.
describe('the Timeline on the shared filter', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('reads through the shared-filter page query, never the unfiltered one', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0, 'dns')]))
    mount()
    await waitFor(() => expect(b.queryPage).toHaveBeenCalled())
    act(() => {
      filterApi.setAgentType('dns')
      filterApi.setTimeRange({ since: T0 - 3_600_000, before: T0 })
      filterApi.setTargetId('10.0.0.5')
      filterApi.setInScopeOnly(true)
    })
    await waitFor(() => expect(lastCall(b.queryPage)).toMatchObject({
      agentType: 'dns', since: T0 - 3_600_000, before: T0, targetId: '10.0.0.5',
      inScopeOnly: true, hidePersonal: true, excludeHousekeeping: true
    }))
    expect(b.query).not.toHaveBeenCalled()
  })

  it('starts over on a filter change and drops the reply to the old filter', async () => {
    const first = deferred<ReturnType<typeof page>>()
    b.queryPage.mockReturnValueOnce(first.promise)
    b.queryPage.mockResolvedValue(page([makeEvent('new', T0, 'dns')]))
    mount()
    act(() => { filterApi.setAgentType('dns') })
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    await act(async () => { first.resolve(page([makeEvent('old-1', T0 - 1), makeEvent('old-2', T0 - 2)])) })
    expect(status()).toMatch(/\b1 event/)
  })

  it('states "N of M" while older rows exist, from the count over the same filter', async () => {
    firstPageOnly(b, page([makeEvent('e1', T0), makeEvent('e2', T0 - 1)], true, 'c1'))
    b.count.mockResolvedValue(57)
    mount()
    await waitFor(() => expect(status()).toContain('2 of 57 events'))
    expect(status()).toContain('scroll back for older')
    expect(lastCall(b.count)).toMatchObject({ excludeHousekeeping: true })
  })

  it('says the total is unavailable when counting fails, never zero', async () => {
    firstPageOnly(b, page([makeEvent('e1', T0)], true, 'c1'))
    b.count.mockRejectedValue(new Error('db locked'))
    mount()
    await waitFor(() => expect(status()).toContain('total unavailable'))
    expect(status()).not.toMatch(/of 0/)
    expect(screen.getByTestId('timeline-total-retry')).toBeTruthy()
  })

  it('shows a failed page as a failure with retry, not as an empty timeline', async () => {
    b.queryPage.mockRejectedValue(new Error('no such table'))
    mount()
    await screen.findByTestId('timeline-load-failed')
    expect(screen.queryByText('No events recorded yet')).toBeNull()
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0)]))
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
  })

  it('lists the active conditions when the filter matches nothing', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0)]))
    mount()
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    b.queryPage.mockResolvedValue(page([]))
    act(() => { filterApi.setAgentType('dns') })
    const empty = await screen.findByTestId('timeline-empty-filtered')
    // Named as the FilterBar names it (Spec 034): "Type: DNS", not `dns`.
    expect(empty.textContent).toContain('Type: DNS')
    expect(screen.queryByText('No events recorded yet')).toBeNull()
  })

  it('admits live rows through the persistence layer and adds them to the total', async () => {
    firstPageOnly(b, page([makeEvent('e1', T0)], true, 'c1'))
    b.count.mockResolvedValue(10)
    mount()
    await waitFor(() => expect(status()).toContain('1 of 10 events'))
    b.matchIds.mockResolvedValueOnce(['live-2'])
    await act(async () => { b.emitBatch([makeEvent('live-1', T0 + 1), makeEvent('live-2', T0 + 2)]) })
    await waitFor(() => expect(status()).toContain('2 of 11 events'))
    expect(lastCall(b.matchIds)).toMatchObject({ ids: ['live-1', 'live-2'], excludeHousekeeping: true })
  })

  it('says when a live batch could not be checked against the filter', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0)]))
    mount()
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    b.matchIds.mockRejectedValueOnce(new Error('busy'))
    await act(async () => { b.emitBatch([makeEvent('live-1', T0 + 1)]) })
    await screen.findByTestId('timeline-live-failed')
  })

  it('clears and explains a selection the new filter excludes', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('sel', T0, 'shell')]))
    mount()
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    selectOnlyDot()
    b.queryPage.mockResolvedValue(page([makeEvent('d1', T0 - 5, 'dns')]))
    b.matchIds.mockResolvedValue([])
    act(() => { filterApi.setAgentType('dns') })
    await screen.findByTestId('timeline-outside-filter')
  })

  it('labels its time-range export as unfiltered while a filter hides events', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0)]))
    mount()
    await waitFor(() => expect(getViewExport()?.label).toBe('Visible time range'))
    act(() => { filterApi.setAgentType('dns') })
    await waitFor(() => expect(getViewExport()?.label).toBe('Visible time range, filter not applied'))
    expect(getViewExport()?.count).toBeUndefined()
  })

  it('shows loading until the first page, then marks the total as pending', async () => {
    const first = deferred<ReturnType<typeof page>>()
    const total = deferred<number>()
    b.queryPage.mockImplementation((opts: { cursor?: string | null }) => opts.cursor ? new Promise(() => {}) : first.promise)
    b.count.mockReturnValueOnce(total.promise)
    mount()
    expect(screen.getByText('Loading...')).toBeTruthy()
    await act(async () => { first.resolve(page([makeEvent('e1', T0)], true, 'c1')) })
    await waitFor(() => expect(status()).toContain('1 of … events'))
    await act(async () => { total.resolve(5) })
    await waitFor(() => expect(status()).toContain('1 of 5 events'))
  })

  it('opens an excluded marker from its amendment without drawing it', async () => {
    const amendment = makeEvent('amd', T0, 'marker', { data: { subtype: 'amended', markerId: 'mk', title: 'new' } })
    b.queryPage.mockResolvedValue(page([amendment]))
    b.getById.mockResolvedValue([makeEvent('mk', T0 - 86_400_000, 'marker', { data: { title: 'old' } })])
    b.matchIds.mockResolvedValue([])
    mount()
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    selectOnlyDot()
    fireEvent.click(await screen.findByTestId('marker-amend-resolve-original'))
    await screen.findByTestId('timeline-outside-filter')
    expect(status()).toMatch(/\b1 event/)
  })

  it('shows lane chips only for lanes the admitted rows populate', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('d1', T0, 'dns')]))
    mount()
    await waitFor(() => expect(status()).toMatch(/\b1 event/))
    expect(screen.queryByTitle(/Shell/i)).toBeNull()
  })
})

// T057 (Constitution II): "No events recorded yet" is a claim about the
// project. It was chosen whenever nothing was drawn and FilterContext's
// activeCount was 0, which leaves out personal traffic and ignores display
// folding, so rows the project holds read as never recorded.
describe('an empty Timeline says why it is empty', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('names personal traffic when hiding it leaves nothing', async () => {
    const bridge = window as unknown as { redlog: { config: { get: () => Promise<unknown> } } }
    bridge.redlog.config.get = async () => ({ scope: { targets: [], excludeTargets: [], personalDomains: ['gmail.com'] } })
    b.queryPage.mockResolvedValue(page([]))
    mount()
    const empty = await screen.findByTestId('timeline-empty-filtered')
    expect(empty.textContent).toContain('Non-work hidden')
    expect(screen.queryByText('No events recorded yet')).toBeNull()
  })

  it('says the rows are folded when the agent-turn collapse hides every one (FR-015)', async () => {
    localStorage.setItem('redlog-timeline-collapse-agent', '1')
    firstPageOnly(b, page([
      makeEvent('a1', T0, 'agent', { data: { subtype: 'tool_call' } }),
      makeEvent('a2', T0 - 1000, 'agent', { data: { subtype: 'assistant_message' } })
    ]))
    mount()
    const folded = await screen.findByTestId('timeline-all-folded')
    expect(folded.textContent).toContain('2')
    expect(screen.queryByText('No events recorded yet')).toBeNull()
    fireEvent.click(within(folded).getByRole('button'))
    await waitFor(() => expect(screen.queryByTestId('timeline-all-folded')).toBeNull())
    expect(screen.queryByText('No events recorded yet')).toBeNull()
  })
})
