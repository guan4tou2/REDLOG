// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

const base = (): SharedFilter => ({
  targetId: null, agentType: null, timeRange: null, inScopeOnly: false, hidePersonal: true, tier: 'all'
})
const state: { filter: SharedFilter } = { filter: base() }

vi.mock('../src/renderer/src/lib/FilterContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/FilterContext')>()
  return {
    ...actual,
    useSharedFilter: () => ({
      filter: state.filter, scopeTargets: ['h1'], scopeExcludeTargets: [], personalDomains: [],
      knownTargets: [], knownAgentTypes: [], activeCount: 0,
      setTargetId: () => {}, setAgentType: () => {}, setTimeRange: () => {}, setInScopeOnly: () => {},
      setHidePersonal: () => {}, setTier: () => {}, clearAll: () => {}
    })
  }
})

const emptyPage = { items: [], hasMore: false, nextCursor: null }
let events: Record<string, Mock>

beforeEach(() => {
  installTimelineBridge()
  events = (window as unknown as { redlog: { events: Record<string, Mock> } }).redlog.events
  events.queryPage.mockResolvedValue(emptyPage)
  events.runQuery.mockResolvedValue(emptyPage)
  events.queryHttpFlowPage = vi.fn(async () => ({ ...emptyPage, flowCount: 0 }))
  events.searchCasts = vi.fn(async () => [])
  events.castIndexStatus = vi.fn(async () => ({ total: 0, indexed: 0, pending: 0 }))
  events.toolCounterparts = vi.fn(async () => [])
  state.filter = base()
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

type View = 'search' | 'transcript' | 'loot' | 'http'

async function mountView(view: View): Promise<ReturnType<typeof render>> {
  const wrap = (el: JSX.Element): ReturnType<typeof render> => render(<I18nProvider>{el}</I18nProvider>)
  if (view === 'search') {
    const { SearchPanel } = await import('../src/renderer/src/components/SearchPanel')
    const r = wrap(<SearchPanel />)
    fireEvent.change(await screen.findByTestId('search-input'), { target: { value: 'nmap' } })
    return r
  }
  if (view === 'transcript') {
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    return wrap(<TranscriptView />)
  }
  if (view === 'loot') {
    const { LootPanel } = await import('../src/renderer/src/components/LootPanel')
    return wrap(<LootPanel />)
  }
  const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
  return wrap(<HttpHistoryPanel />)
}

/** The shared-filter part of the view's latest read. */
function lastRequest(view: View): Record<string, unknown> | undefined {
  const fn = view === 'search' ? events.runQuery : view === 'http' ? events.queryHttpFlowPage : events.queryPage
  const arg = fn.mock.calls[fn.mock.calls.length - 1]?.[0] as Record<string, unknown> | undefined
  return view === 'search' ? arg?.filter as Record<string, unknown> | undefined : arg
}

const CHIPS: Array<{ name: string; set: Partial<SharedFilter>; expect: Record<string, unknown> }> = [
  { name: 'target', set: { targetId: 'h1' }, expect: { targetId: 'h1' } },
  // `shell` is one of the Transcript's buckets; `dns` is not.
  { name: 'type', set: { agentType: 'shell' }, expect: { agentType: 'shell' } },
  { name: 'unbucketed type', set: { agentType: 'dns' }, expect: { agentType: 'dns' } },
  { name: 'time', set: { timeRange: { since: 10, before: 20 } }, expect: { since: 10, before: 20 } },
  { name: 'in scope', set: { inScopeOnly: true }, expect: { inScopeOnly: true } },
  { name: 'personal', set: { hidePersonal: true }, expect: { hidePersonal: true } },
  { name: 'tier', set: { tier: 'chained' }, expect: { tier: 'chained' } }
]
// Where a view says so instead of carrying the chip (FR-012).
const NOTICE: Partial<Record<View, Partial<Record<string, string>>>> = {
  // Cannot honour it: HTTP History pins the proxy's type, and the Transcript
  // only buckets the types it knows.
  http: { type: 'unapplied-filter-notice', 'unbucketed type': 'unapplied-filter-notice', tier: 'empty-by-construction-notice' },
  transcript: { 'unbucketed type': 'unapplied-filter-notice' },
  // Honoured, and empty by construction: Loot lists only loot rows.
  loot: { type: 'empty-by-construction-notice', 'unbucketed type': 'empty-by-construction-notice' }
}

// SC-004: on every view that shows the FilterBar, a lit chip is applied or
// disclosed. Each view carries it into its read, or says why it cannot.
describe('every event view honours every shared-filter chip', () => {
  for (const view of ['search', 'transcript', 'loot', 'http'] as View[]) {
    for (const chip of CHIPS) {
      it(`${view} × ${chip.name}`, async () => {
        state.filter = { ...base(), ...chip.set }
        await mountView(view)
        const notice = NOTICE[view]?.[chip.name]
        if (notice) {
          expect(await screen.findByTestId(notice)).not.toBeNull()
          return
        }
        await waitFor(() => expect(lastRequest(view)).toMatchObject(chip.expect))
      })
    }
  }

  // A chip turned on after the view mounted re-reads with it: a dependency
  // list that names the filter fields one by one must include the tier.
  for (const view of ['search', 'transcript', 'loot'] as View[]) {
    it(`${view} re-reads when the tier changes`, async () => {
      const r = await mountView(view)
      await waitFor(() => expect(lastRequest(view)).toBeDefined())
      state.filter = { ...base(), tier: 'chained' }
      const { SearchPanel } = await import('../src/renderer/src/components/SearchPanel')
      const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
      const { LootPanel } = await import('../src/renderer/src/components/LootPanel')
      const el = view === 'search' ? <SearchPanel /> : view === 'transcript' ? <TranscriptView /> : <LootPanel />
      r.rerender(<I18nProvider>{el}</I18nProvider>)
      await waitFor(() => expect(lastRequest(view)).toMatchObject({ tier: 'chained' }))
    })
  }
})

describe('views empty by construction say so (FR-012)', () => {
  it('HTTP History under chained only: its flows are all logged', async () => {
    state.filter = { ...base(), tier: 'chained' }
    await mountView('http')
    const notice = await screen.findByTestId('empty-by-construction-notice')
    expect(notice.textContent).toContain('logged tier')
    expect(screen.queryByTestId('unapplied-filter-notice')).toBeNull()
    // The notice is why the list is empty. "No HTTP traffic captured yet"
    // beside it would claim what this view cannot know.
    expect(screen.queryByText('No HTTP traffic captured yet.')).toBeNull()
  })

  it('HTTP History under a Type it cannot serve does not claim there is no traffic', async () => {
    state.filter = { ...base(), agentType: 'shell' }
    await mountView('http')
    expect(await screen.findByTestId('unapplied-filter-notice')).not.toBeNull()
    expect(screen.queryByText('No HTTP traffic captured yet.')).toBeNull()
  })

  it('Loot with a Type other than loot: it lists only loot rows', async () => {
    state.filter = { ...base(), agentType: 'shell' }
    await mountView('loot')
    const notice = await screen.findByTestId('empty-by-construction-notice')
    expect(notice.textContent).toContain('only loot')
  })
})
