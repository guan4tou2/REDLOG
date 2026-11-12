// @vitest-environment jsdom

// The HTTP History host column, as seen in the running app: a flow whose
// events carry no `host` field showed only the scope word, and with no scope
// declared every row repeated 「未設定範圍」.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

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

function mount(items: unknown[], policy: { targets: string[]; excludeTargets: string[] } | null): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: vi.fn(async () => ({ items, flowCount: 1, hasMore: false, nextCursor: null })),
      getById: vi.fn(async () => []),
      onNewBatch: () => () => {}
    },
    scope: { policy: async () => policy }
  }
}
const req = (url: string, extra: Record<string, unknown> = {}): unknown =>
  ({ id: 'r1', timestamp: 1000, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url, ...extra } })

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('HTTP History host column', () => {
  it('takes the host from the URL when the event has no host field', async () => {
    mount([req('https://api.target.test:8443/login')], { targets: ['target.test'], excludeTargets: [] })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    expect(await screen.findByTitle('api.target.test')).toBeTruthy()
  })

  it('keeps the host field when the event has one', async () => {
    mount([req('https://10.0.0.5/x', { host: 'vhost.target.test' })], { targets: ['10.0.0.5'], excludeTargets: [] })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    expect(await screen.findByTitle('vhost.target.test')).toBeTruthy()
  })

  it('does not repeat "no scope" on every row when no scope is declared', async () => {
    mount([req('https://outside.test/a', { host: 'outside.test' })], { targets: [], excludeTargets: [] })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await screen.findByTitle('outside.test')
    // Let the scope read land before asking what the row says.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByText('httpScope.no-scope')).toBeNull()
    expect(screen.queryByTestId('http-scope-state')).toBeNull()
  })

  it('still marks a row that is out of a declared scope', async () => {
    mount([req('https://outside.test/a', { host: 'outside.test' })], { targets: ['inside.test'], excludeTargets: [] })
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)
    await waitFor(() => expect(screen.getByTestId('http-scope-state').getAttribute('data-scope')).toBe('out-of-scope'))
  })
})
