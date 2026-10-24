// @vitest-environment jsdom

// Spec 010 US2/FR-007: HTTP History auto-follows its cursor to completion, so a
// session loads whole without the operator clicking "Load More" page by page.
// The recent-subset state and that button are a backstop, reached only at
// AUTO_LOAD_MAX_FLOWS — past it the panel rests rather than pulling an unbounded
// record into the renderer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const sharedFilter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: sharedFilter, scopeTargets: [], scopeExcludeTargets: [] }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn(), toastDeferred: vi.fn() }))
vi.mock('../src/renderer/src/lib/exportScope', () => ({ useContributeExport: () => {} }))

interface Page { items: unknown[]; flowCount: number; hasMore: boolean; nextCursor: string | null }

// A page of `count` complete flows (request + response halves), each with a
// unique flow id so the panel's dedup-by-flowId keeps them all.
function flowPage(start: number, count: number, hasMore: boolean): Page {
  const items: unknown[] = []
  for (let i = start; i < start + count; i++) {
    const fid = `f-${i}`
    items.push({ id: `${fid}-req`, timestamp: 1000 + i, agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: fid, host: 'target.test', method: 'GET', url: `http://target.test/${i}` } })
    items.push({ id: `${fid}-res`, timestamp: 1001 + i, agentType: 'scanner', data: { subtype: 'http_response', flow_id: fid, status: 200 } })
  }
  return { items, flowCount: count, hasMore, nextCursor: hasMore ? `cursor-${start + count}` : null }
}

function installBridge(pages: Page[]): ReturnType<typeof vi.fn> {
  let call = 0
  const queryHttpFlowPage = vi.fn(async (_options?: { http: { statusPrefix?: string } }) => pages[Math.min(call++, pages.length - 1)])
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryHttpFlowPage, getById: vi.fn(async () => []), onNewBatch: () => () => {} }
  }
  return queryHttpFlowPage
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('HTTP History auto-load', () => {
  it('links a genuinely empty record to capture settings', async () => {
    installBridge([flowPage(0, 0, false)])
    const onOpenSettings = vi.fn()
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel onOpenSettings={onOpenSettings} />)
    fireEvent.click(await screen.findByRole('button', { name: 'browser.openSettings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('does not suggest setup for an empty target selection', async () => {
    sharedFilter.targetId = 'target.test' as never
    try {
      installBridge([flowPage(0, 0, false)])
      const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
      render(<HttpHistoryPanel onOpenSettings={vi.fn()} />)
      await screen.findByText('httpHistory.empty')
      expect(screen.queryByRole('button', { name: 'browser.openSettings' })).toBeNull()
    } finally { sharedFilter.targetId = null }
  })

  it('does not present a failed query as an empty complete record or a setup problem', async () => {
    const query = installBridge([flowPage(0, 0, false)])
    query.mockRejectedValue(new Error('database unavailable'))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel onOpenSettings={vi.fn()} />)
    await screen.findByTestId('http-load-error')
    expect(screen.queryByText('httpHistory.empty')).toBeNull()
    expect(screen.queryByText('httpHistory.complete')).toBeNull()
    expect(screen.queryByRole('button', { name: 'browser.openSettings' })).toBeNull()
  })

  it('clears the local status filter when All is chosen', async () => {
    const query = installBridge([flowPage(0, 1, false)])
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '2xx' }))
    await waitFor(() => expect(query.mock.lastCall?.[0]?.http.statusPrefix).toBe('2'))
    expect(screen.getByRole('button', { name: 'httpHistory.filterAll' }).getAttribute('aria-pressed')).toBe('false')
    const before = query.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'httpHistory.filterAll' }))
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(before))
    expect(query.mock.lastCall?.[0]?.http.statusPrefix).toBeUndefined()
    expect(screen.getByRole('button', { name: 'httpHistory.filterAll' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('follows the cursor across pages to completion with no click', async () => {
    const query = installBridge([
      flowPage(0, 3, true),
      flowPage(3, 3, true),
      flowPage(6, 3, false)
    ])
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    // All three pages are fetched unattended, and the view settles on complete.
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByTestId('http-completeness').textContent).toBe('httpHistory.complete'))
    // No manual continue was ever needed below the cap.
    expect(screen.queryByText('httpHistory.loadMore')).toBeNull()
  })

  it('stops at the cap and rests in the subset state with a manual continue', async () => {
    const { AUTO_LOAD_MAX_FLOWS } = await import('../src/renderer/src/components/HttpHistoryPanel')
    const PAGE = 500
    const pages: Page[] = []
    // Enough pages to reach the cap, each still reporting more behind it.
    for (let loaded = 0; loaded <= AUTO_LOAD_MAX_FLOWS; loaded += PAGE) {
      pages.push(flowPage(loaded, PAGE, true))
    }
    const expectedCalls = Math.ceil(AUTO_LOAD_MAX_FLOWS / PAGE) // first load + auto-follows, until length >= cap
    const query = installBridge(pages)
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    // It auto-loads up to the cap, then stops asking.
    await waitFor(() => expect(screen.getByText('httpHistory.loadMore')).not.toBeNull())
    expect(query).toHaveBeenCalledTimes(expectedCalls)
    expect(screen.getByTestId('http-completeness').textContent).toBe('httpHistory.recentSubset')

    // The chain does not resume on its own after it has rested.
    await new Promise((r) => setTimeout(r, 50))
    expect(query).toHaveBeenCalledTimes(expectedCalls)
  })
})
