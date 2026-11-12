// @vitest-environment jsdom

// Every HTTP History reload — a changed filter, and the debounced refresh
// while a proxy is live — set loading and emptied the flows, and the whole
// panel became a spinner: the filter input unmounted under the cursor, and
// the table and the open request blinked several times a second.
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
// jsdom has no layout, so the real virtualizer mounts no rows: draw them all.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (o: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 42, end: (index + 1) * 42, size: 42, key: index })),
    getTotalSize: () => o.count * 42,
    scrollToIndex: () => {},
    measureElement: () => {}
  })
}))

interface Page { items: unknown[]; flowCount: number; hasMore: boolean; nextCursor: string | null }

function flowPage(ids: number[], host = 'target.test', hasMore = false): Page {
  const items: unknown[] = []
  for (const i of ids) {
    const fid = `f-${i}`
    items.push({ id: `${fid}-req`, timestamp: 1000 + i, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: fid, host, method: 'GET', url: `http://${host}/${i}` } })
    items.push({ id: `${fid}-res`, timestamp: 1001 + i, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_response', flow_id: fid, status: 200 } })
  }
  return { items, flowCount: ids.length, hasMore, nextCursor: hasMore ? 'c' : null }
}

type Batch = (events: unknown[]) => void
function installBridge(): { query: ReturnType<typeof vi.fn>; emit: Batch } {
  const listeners = new Set<Batch>()
  const query = vi.fn()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: query,
      getById: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, engagementId: 'p', data: { subtype: 'http_response', status: 200 } }))),
      onNewBatch: (cb: Batch) => { listeners.add(cb); return () => listeners.delete(cb) }
    },
    scope: { policy: async () => null }
  }
  return { query, emit: (events) => { for (const cb of listeners) cb(events) } }
}

const liveFlow = [{ id: 'x', agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f-9' } }]
const count = (): string => screen.getByText(/^httpHistory\.counts/).textContent ?? ''

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })

describe('HTTP History while reloading', () => {
  it('keeps the filter input mounted and focused across a reload', async () => {
    const { query } = installBridge()
    query.mockResolvedValueOnce(flowPage([1, 2]))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    const input = await screen.findByPlaceholderText('httpHistory.filterPlaceholder')
    input.focus()
    let answer!: (p: Page) => void
    query.mockImplementationOnce(() => new Promise<Page>((r) => { answer = r }))
    fireEvent.change(input, { target: { value: 'admin' } })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    // The question is in flight: the box, and the rows it is narrowing, stay.
    expect(screen.getByPlaceholderText('httpHistory.filterPlaceholder')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(count()).toContain('"flows":2')
    await act(async () => { answer(flowPage([2])) })
    expect(count()).toContain('"flows":1')
    expect(document.activeElement).toBe(input)
  })

  it('merges a live refresh into the loaded rows and keeps the open detail', async () => {
    const { query, emit } = installBridge()
    query.mockResolvedValueOnce(flowPage([1, 2]))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    fireEvent.click(await screen.findByTitle('http://target.test/1'))
    await screen.findByTestId('http-detail-panel')
    let answer!: (p: Page) => void
    query.mockImplementationOnce(() => new Promise<Page>((r) => { answer = r }))
    await act(async () => { emit(liveFlow) })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2), { timeout: 2000 })
    // While the refresh is out, nothing has gone.
    expect(screen.getByTestId('http-detail-panel')).toBeTruthy()
    expect(count()).toContain('"flows":2')
    await act(async () => { answer(flowPage([9, 2], 'target.test', true)) })
    expect(count()).toContain('"flows":3')
    expect(screen.getByTitle('http://target.test/1')).toBeTruthy()
    expect(screen.getByTestId('http-detail-panel')).toBeTruthy()
  })

  it('asks again from the top when the newest page shares nothing with what is loaded', async () => {
    const { query, emit } = installBridge()
    query.mockResolvedValueOnce(flowPage([1, 2]))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await screen.findByTitle('http://target.test/1')
    query.mockResolvedValueOnce(flowPage([50, 51], 'target.test', true))
    query.mockResolvedValueOnce(flowPage([50, 51, 1, 2]))
    await act(async () => { emit(liveFlow) })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(3), { timeout: 2000 })
    await waitFor(() => expect(count()).toContain('"flows":4'))
  })

  it('keeps the host menu while a host is chosen, so it can be changed back', async () => {
    const { query } = installBridge()
    query.mockResolvedValueOnce({ ...flowPage([1]), items: [...flowPage([1], 'a.test').items, ...flowPage([2], 'b.test').items] })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    const select = await screen.findByRole('combobox') as HTMLSelectElement
    query.mockResolvedValueOnce(flowPage([1], 'a.test'))
    fireEvent.change(select, { target: { value: 'a.test' } })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(count()).toContain('"flows":1'))
    const still = screen.getByRole('combobox') as HTMLSelectElement
    expect(still.value).toBe('a.test')
    query.mockResolvedValueOnce({ ...flowPage([1]), items: [...flowPage([1], 'a.test').items, ...flowPage([2], 'b.test').items] })
    fireEvent.change(still, { target: { value: '' } })
    await waitFor(() => expect(query.mock.lastCall?.[0]?.http.host).toBeUndefined())
  })
})
