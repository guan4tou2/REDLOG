// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function installBridge(runQuery: ReturnType<typeof vi.fn>, searchCasts = vi.fn().mockResolvedValue([])): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      runQuery,
      searchCasts,
      castIndexStatus: vi.fn().mockResolvedValue({ pending: 0 }),
      distinctAgentTypes: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue([])
    },
    marker: { amendments: vi.fn().mockResolvedValue([]) }
  }
}

async function searchFor(runQuery: ReturnType<typeof vi.fn>, value = 'needle'): Promise<void> {
  fireEvent.change(screen.getByTestId('search-input'), { target: { value } })
  await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 1500 })
}

describe('Search result integrity', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('shows a failed event query as an error and never as no results', async () => {
    const searchPage = vi.fn().mockRejectedValue(new Error('database unavailable'))
    installBridge(searchPage)
    render(<SearchPanel />)
    await searchFor(searchPage)

    expect(await screen.findByTestId('search-error')).not.toBeNull()
    expect(screen.queryByText('search.noResults:needle')).toBeNull()
    expect(screen.getByRole('button', { name: 'common.retry' })).not.toBeNull()
  })

  it('labels successful event matches as partial when cast search fails', async () => {
    const event = {
      id: 'event-1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op',
      agentType: 'shell', hostname: 'host', sourceIP: null, targetId: null,
      data: { command: 'needle' }, hash: 'hash', prevHash: null, createdAt: 1
    }
    const searchPage = vi.fn().mockResolvedValue({ items: [event], hasMore: false, nextCursor: null })
    installBridge(
      searchPage,
      vi.fn().mockRejectedValue(new Error('cast index unavailable'))
    )
    render(<SearchPanel />)
    await searchFor(searchPage)

    expect(await screen.findByTestId('search-partial-warning')).not.toBeNull()
    expect(screen.getByText('$ needle')).not.toBeNull()
  })

  it('retries the unchanged query after failure', async () => {
    const searchPage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(emptyPage)
    installBridge(searchPage)
    render(<SearchPanel />)
    await searchFor(searchPage, 'same query')
    fireEvent.click(await screen.findByRole('button', { name: 'common.retry' }))

    await waitFor(() => expect(searchPage).toHaveBeenCalledTimes(2))
    expect(searchPage.mock.calls[0][0].parsed.text).toBe('same query')
    expect(searchPage.mock.calls[1][0].parsed.text).toBe('same query')
  })

  it('preserves loaded rows and the cursor when load more fails', async () => {
    const event = {
      id: 'event-1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op',
      agentType: 'shell', hostname: 'host', sourceIP: null, targetId: null,
      data: { command: 'needle' }, hash: 'hash', prevHash: null, createdAt: 1
    }
    const searchPage = vi.fn()
      .mockResolvedValueOnce({ items: [event], hasMore: true, nextCursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('next page unavailable'))
    installBridge(searchPage)
    render(<SearchPanel />)
    await searchFor(searchPage)
    fireEvent.click(await screen.findByRole('button', { name: 'search.loadMore' }))

    expect(await screen.findByTestId('search-load-more-error')).not.toBeNull()
    expect(screen.getByText('$ needle')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'search.loadMore' })).not.toBeNull()
  })

  it('ignores a superseded query that resolves after the current query', async () => {
    let resolveFirst: (page: typeof emptyPage & { items: unknown[] }) => void = () => {}
    const first = new Promise<typeof emptyPage & { items: unknown[] }>((resolve) => { resolveFirst = resolve })
    const staleEvent = {
      id: 'stale', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op',
      agentType: 'shell', hostname: 'host', sourceIP: null, targetId: null,
      data: { command: 'stale result' }, hash: 'hash', prevHash: null, createdAt: 1
    }
    const searchPage = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(emptyPage)
    installBridge(searchPage)
    render(<SearchPanel />)

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'old query' } })
    await waitFor(() => expect(searchPage).toHaveBeenCalledTimes(1), { timeout: 1500 })
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'current query' } })
    await waitFor(() => expect(searchPage).toHaveBeenCalledTimes(2), { timeout: 1500 })
    resolveFirst({ ...emptyPage, items: [staleEvent] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('$ stale result')).toBeNull()
    expect(screen.getByTestId('search-input')).toHaveProperty('value', 'current query')
  })

  it('shows conditions and text exactly as the shared parser read them', async () => {
    const runQuery = vi.fn().mockResolvedValue(emptyPage)
    installBridge(runQuery)
    render(<SearchPanel />)
    await searchFor(runQuery, 'session:S1 timeout')

    const parse = await screen.findByTestId('search-query-parse')
    expect(parse.textContent).toContain('session:S1')
    expect(parse.textContent).toContain('timeout')
    expect(runQuery.mock.calls[0][0].parsed.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(runQuery.mock.calls[0][0].parsed.text).toBe('timeout')
  })

  it('does not execute a half-written condition', async () => {
    const runQuery = vi.fn().mockResolvedValue(emptyPage)
    installBridge(runQuery)
    render(<SearchPanel />)
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'session:' } })

    expect(await screen.findByTestId('search-query-unparsable')).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('discloses the agent session chosen for a bare tool condition', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      ...emptyPage,
      toolSession: { toolUseId: 'T1', sessionId: 'S2', otherSessionIds: ['S1'] }
    })
    installBridge(runQuery)
    render(<SearchPanel />)
    await searchFor(runQuery, 'tool:T1')

    expect(await screen.findByTestId('search-tool-session')).not.toBeNull()
  })
})
