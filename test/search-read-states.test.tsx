// @vitest-environment jsdom
//
// #298 (read states). The panel must never say "fully indexed" or "no types"
// on the strength of a query that did not answer. Initial pending=0 plus a
// swallowed rejection made a failed status read look like a complete index,
// and an empty output search look authoritative.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SearchPanel } from '../src/renderer/src/components/SearchPanel'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({
    filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  }),
  toEventFilter: () => ({})
}))

vi.mock('../src/renderer/src/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars?.query ? `${key}:${vars.query}` : key
  })
}))

const emptyPage = { items: [], hasMore: false, nextCursor: null }

type Fn = ReturnType<typeof vi.fn>

function installBridge(opts: { castIndexStatus: Fn; distinctAgentTypes?: Fn }): { runQuery: Fn } {
  const runQuery = vi.fn().mockResolvedValue(emptyPage)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      runQuery,
      searchCasts: vi.fn().mockResolvedValue([]),
      castIndexStatus: opts.castIndexStatus,
      distinctAgentTypes: opts.distinctAgentTypes ?? vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue([])
    },
    marker: { amendments: vi.fn().mockResolvedValue([]) }
  }
  return { runQuery }
}

async function searchForNothing(runQuery: Fn): Promise<void> {
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'needle' } })
  await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 1500 })
  await screen.findByText('search.noResults:needle')
}

describe('cast index status is an explicit state', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('a failed status query says the search may be incomplete, never "fully indexed"', async () => {
    const castIndexStatus = vi.fn().mockRejectedValue(new Error('casts db locked'))
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    const banner = await screen.findByTestId('search-index-status')
    expect(banner.getAttribute('data-kind')).toBe('failed')
    expect(within(banner).getByText('castSearch.statusFailed')).not.toBeNull()
    // Results stay readable beneath it.
    expect(screen.getByText('search.noResults:needle')).not.toBeNull()
    expect(screen.queryByText('castSearch.stillIndexing')).toBeNull()
  })

  it('retry asks again and clears the notice once the index answers ready', async () => {
    const castIndexStatus = vi.fn()
      .mockRejectedValueOnce(new Error('casts db locked'))
      .mockResolvedValue({ total: 2, indexed: 2, pending: 0 })
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    const banner = await screen.findByTestId('search-index-status')
    fireEvent.click(within(banner).getByRole('button', { name: 'common.retry' }))

    await waitFor(() => expect(screen.queryByTestId('search-index-status')).toBeNull())
    expect(castIndexStatus).toHaveBeenCalledTimes(2)
  })

  it('a status query that has not answered is unknown, not ready', async () => {
    const castIndexStatus = vi.fn(() => new Promise(() => {}))
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    const banner = await screen.findByTestId('search-index-status')
    expect(banner.getAttribute('data-kind')).toBe('unknown')
    expect(within(banner).getByText('castSearch.statusUnknown')).not.toBeNull()
  })

  it('a malformed status answer is a failure, not zero pending', async () => {
    const castIndexStatus = vi.fn().mockResolvedValue(null)
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    expect((await screen.findByTestId('search-index-status')).getAttribute('data-kind')).toBe('failed')
  })

  it('a fully indexed project shows no index notice', async () => {
    const castIndexStatus = vi.fn().mockResolvedValue({ total: 3, indexed: 3, pending: 0 })
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    await waitFor(() => expect(castIndexStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('search-index-status')).toBeNull()
  })

  it('a pending index keeps the existing still-indexing notice', async () => {
    const castIndexStatus = vi.fn().mockResolvedValue({ total: 3, indexed: 1, pending: 2 })
    const { runQuery } = installBridge({ castIndexStatus })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    await waitFor(() => expect(screen.getAllByText('castSearch.stillIndexing').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('search-index-status')).toBeNull()
  })
})

describe('agent-type facets are an explicit state', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  const okStatus = (): Fn => vi.fn().mockResolvedValue({ total: 0, indexed: 0, pending: 0 })

  it('a failed facets query is flagged, with retry', async () => {
    // Facets re-read with every result set, so the fault has to outlast the
    // search itself and end only when the user retries.
    let broken = true
    const distinctAgentTypes = vi.fn(async () => {
      if (broken) throw new Error('db busy')
      return ['shell', 'agent']
    })
    const { runQuery } = installBridge({ castIndexStatus: okStatus(), distinctAgentTypes })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    const note = await screen.findByTestId('search-types-failed')
    expect(within(note).getByText('search.typesFailed')).not.toBeNull()
    broken = false
    fireEvent.click(within(note).getByRole('button', { name: 'common.retry' }))

    await waitFor(() => expect(screen.queryByTestId('search-types-failed')).toBeNull())
    expect(await screen.findByText('shell')).not.toBeNull()
  })

  it('"there are no types" is not a failure', async () => {
    const distinctAgentTypes = vi.fn().mockResolvedValue([])
    const { runQuery } = installBridge({ castIndexStatus: okStatus(), distinctAgentTypes })
    render(<SearchPanel />)
    await searchForNothing(runQuery)

    await waitFor(() => expect(distinctAgentTypes).toHaveBeenCalled())
    expect(screen.queryByTestId('search-types-failed')).toBeNull()
  })
})
