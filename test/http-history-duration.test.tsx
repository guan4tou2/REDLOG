// @vitest-environment jsdom

// Real-window audit with dense traffic: the 耗時 column cut "123456ms" to
// "123456…", dropping the unit, so a two-minute request read as a smaller
// number. A number is never truncated: the cell prints a short form that fits
// and keeps the exact value in its title.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatElapsedMs } from '../src/renderer/src/lib/time'

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

describe('formatElapsedMs', () => {
  it.each([
    [0, '0 ms'],
    [999, '999 ms'],
    [999.6, '1.0s'],
    [1000, '1.0s'],
    [59_949, '59.9s'],
    [59_999, '1m 0s'],
    [60_000, '1m 0s'],
    [123_456, '2m 3s'],
    [3_599_499, '59m 59s'],
    [3_600_000, '1h 0m'],
    [359_999_999, '100h 0m']
  ])('%d ms → %s', (ms, out) => {
    expect(formatElapsedMs(ms)).toBe(out)
  })

  it('stays within seven characters below 100 hours', () => {
    for (let ms = 0; ms < 100 * 3_600_000 - 30_000; ms = ms < 10_000 ? ms + 7 : Math.ceil(ms * 1.003)) {
      expect(formatElapsedMs(ms).length, `${ms}`).toBeLessThanOrEqual(7)
    }
  })

  it('prints nothing for a value that is not a duration', () => {
    expect(formatElapsedMs(Number.NaN)).toBe('')
    expect(formatElapsedMs(-1)).toBe('')
  })
})

// jsdom has no layout: every element reports this width, wide enough for the
// size and time columns to be drawn.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 }) })
afterAll(() => { if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

const flowRows = (id: string, at: number, durationMs: number): unknown[] => [
  { id: `${id}-q`, timestamp: at, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_request_start', flow_id: id, method: 'GET', url: `https://app.example/${id}`, host: 'app.example' } },
  { id: `${id}-r`, timestamp: at + 1, agentType: 'scanner', engagementId: 'p', data: { subtype: 'http_response', flow_id: id, method: 'GET', url: `https://app.example/${id}`, status: 200, content_length: 10, duration_ms: durationMs } }
]

async function draw(items: unknown[]): Promise<void> {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryHttpFlowPage: vi.fn(async () => ({ items, flowCount: items.length / 2, hasMore: false, nextCursor: null })),
      getById: vi.fn(async () => []),
      onNewBatch: () => () => {}
    },
    scope: { policy: async () => null }
  }
  const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
  render(<HttpHistoryPanel />)
  await screen.findAllByTestId('http-flow-duration')
}

describe('HTTP History duration cell', () => {
  it('prints the short form, untruncated, with the exact value in its title', async () => {
    await draw(flowRows('slow', 1000, 123_456))
    const cell = screen.getByTestId('http-flow-duration')
    expect(cell.textContent).toBe('2m 3s')
    expect(cell.getAttribute('title')).toBe('123456 ms')
    expect(cell.className).not.toMatch(/(^|\s)(truncate|text-ellipsis|overflow-hidden)(\s|$)/)
    expect(cell.className).toContain('whitespace-nowrap')
  })

  it('sorts by the number, not by the printed text', async () => {
    // As text, "2m 3s" < "5.0s" < "900 ms"; as numbers 900 < 5000 < 123456.
    await draw([...flowRows('a', 1000, 5000), ...flowRows('b', 2000, 123_456), ...flowRows('c', 3000, 900)])
    const durations = (): string[] => screen.getAllByTestId('http-flow-duration').map((c) => c.getAttribute('title') ?? '')
    fireEvent.click(screen.getByRole('button', { name: /httpHistory\.colTime/ }))
    expect(durations()).toEqual(['123456 ms', '5000 ms', '900 ms'])
    fireEvent.click(screen.getByRole('button', { name: /httpHistory\.colTime/ }))
    expect(durations()).toEqual(['900 ms', '5000 ms', '123456 ms'])
  })
})
