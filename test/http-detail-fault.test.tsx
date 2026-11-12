// @vitest-environment jsdom
//
// #691: opening a request whose read fails, or whose event is gone, used to
// close the detail pane silently. It now stays open and says which. Also: the
// sortable column headers are translated buttons with aria-sort, and a panel
// kept mounted but hidden contributes no export scope.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getViewExport } from '../src/renderer/src/lib/exportScope'

const sharedFilter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: sharedFilter, scopeTargets: [], scopeExcludeTargets: [] }),
  toEventFilter: () => ({})
}))
const t = (key: string, vars?: Record<string, unknown>): string => vars ? `${key}:${JSON.stringify(vars)}` : key
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t }) }))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn(), toastDeferred: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 42, end: (index + 1) * 42, size: 42, key: index })),
    getTotalSize: () => o.count * 42,
    scrollToIndex: () => {},
    measureElement: () => {}
  })
}))

function flowPage(): unknown {
  const items = [
    { id: 'f-1-req', timestamp: 1001, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: 'f-1', host: 'a.test', method: 'GET', url: 'http://a.test/1' } },
    { id: 'f-1-res', timestamp: 1002, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_response', flow_id: 'f-1', status: 200 } }
  ]
  return { items, flowCount: 1, hasMore: false, nextCursor: null }
}

function install(getById: (ids: string[]) => Promise<unknown[]>): ReturnType<typeof vi.fn> {
  const get = vi.fn(getById)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryHttpFlowPage: vi.fn(async () => flowPage()), getById: get, onNewBatch: () => () => {} },
    scope: { policy: async () => null }
  }
  return get
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the HTTP detail pane', () => {
  it('stays open in a failed state with a retry when the read fails', async () => {
    const get = install(async () => { throw new Error('db') })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    fireEvent.click(await screen.findByTitle('http://a.test/1'))
    const failed = await screen.findByTestId('http-detail-failed')
    expect(failed.textContent).toContain('httpHistory.detailFailed')
    expect(screen.getByTestId('http-detail-panel')).toBeTruthy()
    get.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, engagementId: 'p', data: { subtype: 'http_response', status: 200 } })))
    fireEvent.click(within(failed).getByRole('button', { name: 'common.retry' }))
    await waitFor(() => expect(screen.queryByTestId('http-detail-failed')).toBeNull())
    expect(get).toHaveBeenLastCalledWith(['f-1-res'])
    expect(screen.getByTestId('http-detail-panel')).toBeTruthy()
  })

  it('says the request is gone, distinctly, when the event no longer exists', async () => {
    install(async () => [])
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    fireEvent.click(await screen.findByTitle('http://a.test/1'))
    expect((await screen.findByTestId('http-detail-missing')).textContent).toBe('httpHistory.detailMissing')
    expect(screen.queryByTestId('http-detail-failed')).toBeNull()
  })
})

describe('the HTTP column headers', () => {
  it('are translated buttons that say how the column is sorted', async () => {
    install(async () => [])
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await screen.findByTitle('http://a.test/1')
    const when = screen.getByRole('button', { name: /httpHistory\.colWhen/ })
    expect(when.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    const status = screen.getByRole('button', { name: /httpHistory\.colStatus/ })
    expect(status.closest('th')?.getAttribute('aria-sort')).toBe('none')
    fireEvent.click(status)
    expect(status.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(when.closest('th')?.getAttribute('aria-sort')).toBe('none')
    for (const key of ['colSize', 'colTime']) expect(screen.getByRole('button', { name: new RegExp(`httpHistory\\.${key}`) })).toBeTruthy()
    expect(screen.queryByText(/^When/)).toBeNull()
  })
})

describe('a hidden HTTP History', () => {
  it('contributes no export scope while inactive, and contributes it again when shown', async () => {
    install(async () => [])
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    const { rerender } = render(<HttpHistoryPanel active={false} />)
    await screen.findByTitle('http://a.test/1')
    expect(getViewExport()).toBeNull()
    await act(async () => { rerender(<HttpHistoryPanel active />) })
    expect(getViewExport()?.label).toBe('httpHistory.exportHar')
    await act(async () => { rerender(<HttpHistoryPanel active={false} />) })
    expect(getViewExport()).toBeNull()
  })
})
