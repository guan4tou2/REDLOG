// @vitest-environment jsdom

// Real-app audit: at an ~800px window, and docked beside the Timeline, the
// HTTP History table's columns ran into each other. An auto-layout table
// ignores a cell's max-width, so `truncate` never engaged and the table grew
// sideways. The table now sizes itself from its own box: fixed layout, and the
// low-priority columns drop out as it narrows.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }, scopeTargets: [], scopeExcludeTargets: [] }),
  toEventFilter: () => ({})
}))
const t = (key: string): string => key
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

// jsdom has no layout: every element reports the width under test.
let width = 0
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width }) })
afterAll(() => { if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

const LONG_HOST = 'a-very-long-subdomain.internal.target-corp.example.test'
const LONG_URL = `https://${LONG_HOST}/api/v2/accounts/123456/settings/notifications?include=all&expand=owner`
const flow = { id: 'r1', timestamp: 1000, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: 'f1', method: 'OPTIONS', url: LONG_URL, host: LONG_HOST } }

async function draw(w: number): Promise<HTMLTableElement> {
  width = w
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: vi.fn(async () => ({ items: [flow], flowCount: 1, hasMore: false, nextCursor: null })),
      getById: vi.fn(async () => []),
      onNewBatch: () => () => {}
    },
    scope: { policy: async () => null }
  }
  const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
  render(<HttpHistoryPanel />)
  await screen.findByTitle(LONG_HOST)
  return document.querySelector('table') as HTMLTableElement
}

const headers = (table: HTMLTableElement): string[] => [...table.querySelectorAll('thead th')].map((th) => th.textContent ?? '')

describe.each([
  [1280, ['httpHistory.colWhen', 'httpHistory.colMethod', 'httpHistory.colStatus', 'httpHistory.colHost', 'httpHistory.colUrl', 'httpHistory.colType', 'httpHistory.colSize', 'httpHistory.colTime']],
  [800, ['httpHistory.colWhen', 'httpHistory.colMethod', 'httpHistory.colStatus', 'httpHistory.colHost', 'httpHistory.colUrl']],
  [520, ['httpHistory.colWhen', 'httpHistory.colMethod', 'httpHistory.colStatus', 'httpHistory.colHost / httpHistory.colUrl']]
] as const)('HTTP History table at %ipx', (w, expected) => {
  it('shows the columns that fit, truncating instead of overlapping', async () => {
    const table = await draw(w)
    // Sort arrows follow some labels; compare the label part.
    expect(headers(table).map((h) => h.replace(/\s*[↑↓▲▼]$/, ''))).toEqual(expected)
    // A fixed table is what makes a cell's truncate engage at all.
    expect(table.className).toContain('table-fixed')
    // No sideways scroll: the scroller hides horizontal overflow.
    const scroller = screen.getByTestId('http-table-scroll')
    expect(scroller.className).toContain('overflow-x-hidden')
    expect(scroller.className).not.toMatch(/(^|\s)overflow-auto(\s|$)/)
    // Every row has one cell per header, and the long values truncate with
    // the full text on hover.
    const row = table.querySelector('tbody tr[role="option"], tbody tr:not([aria-hidden])') as HTMLTableRowElement
    expect(row.cells.length).toBe(expected.length)
    const host = screen.getByTitle(LONG_HOST)
    expect(host.className).toContain('truncate')
    const path = screen.getByTitle(LONG_URL)
    expect(path.className).toContain('truncate')
    expect(path.textContent).toContain('/api/v2/accounts')
  })
})
