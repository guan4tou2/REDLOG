// @vitest-environment jsdom

// HTTP History while a proxy is busy. The live refresh was a 300 ms debounce
// restarted by every batch, so as long as traffic kept arriving faster than
// that the list never updated — it caught up only once the traffic stopped.
// And refreshes were not single-flight: a slow one still out when the next
// started could land last and lay its older copy of a flow (request only, no
// status yet) over the newer one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const sharedFilter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: sharedFilter, scopeTargets: [], scopeExcludeTargets: [] }),
  toEventFilter: () => ({})
}))
const t = (key: string, vars?: Record<string, unknown>): string => vars ? `${key}:${JSON.stringify(vars)}` : key
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t }) }))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn(), toastDeferred: vi.fn() }))
vi.mock('../src/renderer/src/lib/exportScope', () => ({ useContributeExport: () => {} }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 42, end: (index + 1) * 42, size: 42, key: index })),
    getTotalSize: () => o.count * 42,
    scrollToIndex: () => {},
    measureElement: () => {}
  })
}))

interface Page { items: unknown[]; flowCount: number; hasMore: boolean; nextCursor: string | null }

/** Flow f-1 complete; flow f-9 sent, with its response only once `status` is set. */
function pageWith(status: number | null): Page {
  const req = (n: number): unknown => ({ id: `f-${n}-req`, timestamp: 1000 + n, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: `f-${n}`, host: 'target.test', method: 'GET', url: `http://target.test/${n}` } })
  const res = (n: number, s: number): unknown => ({ id: `f-${n}-res`, timestamp: 1001 + n, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_response', flow_id: `f-${n}`, status: s } })
  return { items: [req(1), res(1, 200), req(9), ...(status === null ? [] : [res(9, status)])], flowCount: 2, hasMore: false, nextCursor: null }
}

type Batch = (events: unknown[]) => void
function installBridge(): { query: ReturnType<typeof vi.fn>; emit: () => void } {
  const listeners = new Set<Batch>()
  const query = vi.fn()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: query,
      getById: vi.fn(async () => []),
      onNewBatch: (cb: Batch) => { listeners.add(cb); return () => listeners.delete(cb) }
    },
    scope: { policy: async () => null }
  }
  const live = [{ id: 'x', agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f-9' } }]
  return { query, emit: () => act(() => { for (const cb of listeners) cb(live) }) }
}

const pause = (ms: number): Promise<void> => act(() => new Promise((r) => setTimeout(r, ms)))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('HTTP History under sustained traffic', () => {
  it('refreshes while traffic keeps arriving, not only once it stops', async () => {
    const { query, emit } = installBridge()
    query.mockResolvedValue(pageWith(200))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await screen.findByTitle('http://target.test/1')
    const before = query.mock.calls.length
    const timer = setInterval(emit, 100)
    try {
      await pause(1200)
      expect(query.mock.calls.length).toBeGreaterThan(before)
    } finally { clearInterval(timer) }
  })

  it('a live refresh keeps the table, its scroll offset, the open request and the completeness line', async () => {
    const { query, emit } = installBridge()
    query.mockResolvedValue(pageWith(200))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    fireEvent.click(await screen.findByTitle('http://target.test/1'))
    await screen.findByTestId('http-detail-panel')
    const scroller = screen.getByTestId('http-table-scroll')
    scroller.scrollTop = 120
    const calls = query.mock.calls.length
    emit()
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(calls), { timeout: 2000 })
    await pause(50)
    expect(screen.getByTestId('http-table-scroll')).toBe(scroller)
    expect(scroller.scrollTop).toBe(120)
    expect(screen.getByTestId('http-detail-panel')).toBeTruthy()
    expect(screen.getByTestId('http-completeness').textContent).toBe('httpHistory.complete:{"max":5000}')
  })

  it('a slower, older refresh never overwrites a newer one', async () => {
    const { query, emit } = installBridge()
    // Each read answers with the record as it was when asked, whenever it lands.
    let status: number | null = null
    const pending: Array<() => void> = []
    query.mockImplementation(() => {
      const answer = pageWith(status)
      return new Promise<Page>((resolve) => pending.push(() => resolve(answer)))
    })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => { pending.shift()!() })
    await screen.findByTitle('http://target.test/9')

    emit()
    await pause(500)
    status = 201 // the response lands; traffic says so
    emit()
    await pause(500)
    // The reply asked for last comes back first; the older one after it.
    while (pending.length > 0) {
      await act(async () => { pending.pop()!() })
      await pause(500)
    }
    expect(screen.getByTitle('201')).toBeTruthy()
  })
})
