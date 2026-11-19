// @vitest-environment jsdom

// HTTP History filters in the query, so a filter that matches nothing comes
// back as zero flows — and the empty line was chosen by `flows.length === 0`
// alone. Every filtered-out view said "No HTTP traffic captured yet", and the
// "no flows match" line could never be shown.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

let personalDomains: string[] = []
const sharedFilter: Record<string, unknown> = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: sharedFilter, scopeTargets: [], scopeExcludeTargets: [], personalDomains }),
  // As the real one for the switch these cases turn: on is sent, off is absent.
  toEventFilter: (filter: { hidePersonal?: boolean }) => (filter.hidePersonal ? { hidePersonal: true } : {})
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

function mountEmpty(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: vi.fn(async () => ({ items: [], flowCount: 0, hasMore: false, nextCursor: null })),
      getById: vi.fn(async () => []),
      onNewBatch: () => () => {}
    },
    scope: { policy: async () => null }
  }
}

afterEach(() => {
  cleanup(); vi.clearAllMocks(); personalDomains = []; delete sharedFilter.hidePersonal
  Object.assign(sharedFilter, { targetId: null, agentType: null, timeRange: null, inScopeOnly: false })
})

describe('HTTP History empty line', () => {
  it('says nothing was captured only when no filter is narrowing the list', async () => {
    mountEmpty()
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel onOpenSettings={() => {}} />)
    expect(await screen.findByText('httpHistory.empty')).toBeTruthy()
    expect(screen.queryByText('httpHistory.noMatch')).toBeNull()
  })

  it('says no flows match when a status chip leaves nothing', async () => {
    mountEmpty()
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel onOpenSettings={() => {}} />)
    await screen.findByText('httpHistory.empty')
    fireEvent.click(screen.getByRole('button', { name: '5xx' }))
    expect(await screen.findByText('httpHistory.noMatch')).toBeTruthy()
    expect(screen.queryByText('httpHistory.empty')).toBeNull()
    expect(screen.queryByText('browser.openSettings')).toBeNull()
  })

  it('says no flows match when the text filter leaves nothing', async () => {
    mountEmpty()
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel onOpenSettings={() => {}} />)
    await screen.findByText('httpHistory.empty')
    fireEvent.change(screen.getByPlaceholderText('httpHistory.filterPlaceholder'), { target: { value: 'nothing-here' } })
    await waitFor(() => expect(screen.getByText('httpHistory.noMatch')).toBeTruthy())
    expect(screen.queryByText('httpHistory.empty')).toBeNull()
  })
})

// The non-work filter is on by default. Whether the list is empty because of
// it is a fact about the record, asked with the filter off — not something the
// switch being on can say.
const flow = { id: 'f1', timestamp: 1, agentType: 'http_flow', data: { subtype: 'response', flow_id: 'x', method: 'GET', url: 'http://example.test/', status: 200 } }
function mountWithHidden(hiddenFlows: unknown[]): ReturnType<typeof vi.fn> {
  mountEmpty()
  const query = vi.fn(async (request: { hidePersonal?: boolean }) => (
    { items: request.hidePersonal ? [] : hiddenFlows, flowCount: 0, hasMore: false, nextCursor: null }))
  ;(window as unknown as { redlog: { events: { queryHttpFlowPage: unknown } } }).redlog.events.queryHttpFlowPage = query
  sharedFilter.hidePersonal = true
  personalDomains = ['example.test']
  return query
}

it('says no flows match when the non-work filter is hiding flows', async () => {
  mountWithHidden([flow])
  const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
  render(<HttpHistoryPanel />)
  expect(await screen.findByText('httpHistory.noMatch')).toBeTruthy()
  expect(screen.queryByText('httpHistory.empty')).toBeNull()
})

it('says nothing was captured when the non-work filter is on and hides nothing', async () => {
  const query = mountWithHidden([])
  const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
  render(<HttpHistoryPanel />)
  expect(await screen.findByText('httpHistory.empty')).toBeTruthy()
  expect(screen.queryByText('httpHistory.noMatch')).toBeNull()
  // Asked once with the filter off, for one row.
  expect(query.mock.calls.filter(([request]) => !(request as { hidePersonal?: boolean }).hidePersonal)).toHaveLength(1)
})
