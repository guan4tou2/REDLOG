// @vitest-environment jsdom
// Decisions 2026-11-15 §1 item 4: "hide non-work traffic" is on by default, and
// it used to stop the recording search — so recordings were never searched in
// the default state, and every search said they had been left out, even in a
// project that has none. Recordings are searched whatever that switch says;
// the line appears only when a condition recordings cannot honour is set AND
// the project holds a recording.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SharedFilter } from '../src/renderer/src/lib/FilterContext'
import { SearchPanel } from '../src/renderer/src/components/SearchPanel'

const base = (): SharedFilter => ({
  targetId: null, agentType: null, timeRange: null, inScopeOnly: false, hidePersonal: true, tier: 'all'
})
const state: { filter: SharedFilter } = { filter: base() }

vi.mock('../src/renderer/src/lib/FilterContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/FilterContext')>()
  return { ...actual, useSharedFilter: () => ({ filter: state.filter }) }
})

vi.mock('../src/renderer/src/i18n', () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => vars?.query ? `${key}:${vars.query}` : key })
}))

const emptyPage = { items: [], hasMore: false, nextCursor: null }
let events: Record<string, Mock>

function install(recordings: number): void {
  events = {
    runQuery: vi.fn().mockResolvedValue(emptyPage),
    searchCasts: vi.fn().mockResolvedValue([]),
    castIndexStatus: vi.fn().mockResolvedValue({ total: recordings, indexed: recordings, pending: 0 }),
    distinctAgentTypes: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue([])
  }
  ;(window as unknown as { redlog: unknown }).redlog = { events, marker: { amendments: vi.fn().mockResolvedValue([]) } }
}

async function search(value = 'nmap'): Promise<void> {
  render(<SearchPanel />)
  await waitFor(() => expect(events.castIndexStatus).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('search-input'), { target: { value } })
  // The empty line is only the sign the search finished. Under a condition it
  // says the conditions emptied it instead of naming the query.
  await screen.findByText((text) => text === `search.noResults:${value}` || text === 'search.noEventsFiltered', undefined, { timeout: 1500 })
}

beforeEach(() => { state.filter = base() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('recordings in Search', () => {
  it('searches recordings while non-work traffic is hidden, and says nothing was excluded', async () => {
    install(2)
    await search()
    expect(events.runQuery.mock.calls[0][0].filter).toMatchObject({ hidePersonal: true })
    await waitFor(() => expect(events.searchCasts).toHaveBeenCalledWith('nmap', 50))
    expect(screen.queryByText('activity.castsRestricted')).toBeNull()
  })

  it('searches recordings with non-work traffic shown too', async () => {
    state.filter = { ...base(), hidePersonal: false }
    install(2)
    await search()
    await waitFor(() => expect(events.searchCasts).toHaveBeenCalledWith('nmap', 50))
    expect(screen.queryByText('activity.castsRestricted')).toBeNull()
  })

  const blocking: Array<[string, Partial<SharedFilter>]> = [
    ['target', { targetId: '10.20.0.5' }],
    ['type', { agentType: 'shell' }],
    ['time', { timeRange: { since: 10, before: 20 } }],
    ['in scope', { inScopeOnly: true }],
    ['tier', { tier: 'chained' }]
  ]
  for (const [name, set] of blocking) {
    it(`leaves recordings out under a ${name} condition, and says so when the project has one`, async () => {
      state.filter = { ...base(), ...set }
      install(1)
      await search()
      expect(await screen.findByText('activity.castsRestricted')).toBeTruthy()
      expect(events.searchCasts).not.toHaveBeenCalled()
    })
  }

  it('leaves recordings out under a parsed condition', async () => {
    install(1)
    await search('session:abc nmap')
    expect(await screen.findByText('activity.castsRestricted')).toBeTruthy()
    expect(events.searchCasts).not.toHaveBeenCalled()
  })

  it('says nothing about recordings in a project that has none', async () => {
    state.filter = { ...base(), targetId: '10.20.0.5' }
    install(0)
    await search()
    expect(events.searchCasts).not.toHaveBeenCalled()
    expect(screen.queryByText('activity.castsRestricted')).toBeNull()
  })

  it('says nothing when only conditions were typed, since there is no text to look for in a recording', async () => {
    install(1)
    await search('session:abc')
    expect(events.searchCasts).not.toHaveBeenCalled()
    expect(screen.queryByText('activity.castsRestricted')).toBeNull()
  })
})
