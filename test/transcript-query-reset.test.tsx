// @vitest-environment jsdom
//
// Spec 017 T016. A cursor belongs to the query that produced it. Carrying one
// across a query change would page the new query from the old query's
// position: rows that belong to neither, presented as a continuation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({
    filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const event = (id: string, full: string): Record<string, unknown> => ({
  id, timestamp: 1, operatorId: 'op', agentType: 'agent', targetId: null,
  data: { subtype: 'assistant_message', agent: 'codex', full }
})

function installBridge(): { queryPage: ReturnType<typeof vi.fn>; runQuery: ReturnType<typeof vi.fn> } {
  // Every page reports more, so a stale cursor would be offered and used.
  const queryPage = vi.fn().mockImplementation((opts: { agentType: string }) =>
    Promise.resolve(opts.agentType === 'agent'
      ? { items: [event('unqueried-1', 'unqueried evidence')], hasMore: true, nextCursor: 'plain-cursor' }
      : { items: [], hasMore: false, nextCursor: null }))
  const runQuery = vi.fn().mockImplementation((req: { filter: { agentType: string } }) =>
    Promise.resolve(req.filter.agentType === 'agent'
      ? { items: [event('queried-1', 'queried evidence')], hasMore: true, nextCursor: 'query-cursor' }
      : { items: [], hasMore: false, nextCursor: null }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, runQuery, toolCounterparts: vi.fn().mockResolvedValue([]), onNewBatch: () => () => {} },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
  return { queryPage, runQuery }
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('a cursor belongs to its query (T016)', () => {
  it('starts a new query from the first page, not the previous cursor', async () => {
    const { runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('unqueried evidence')

    type('first')
    await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 3000 })
    runQuery.mockClear()

    type('second')
    await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 3000 })
    expect(runQuery.mock.calls.every((c) => c[0].cursor == null)).toBe(true)
  })

  it('drops the previous query\'s rows rather than merging them', async () => {
    installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('unqueried evidence')

    type('first')
    await screen.findByText('queried evidence')
    expect(screen.queryByText('unqueried evidence')).toBeNull()
  })

  it('returns to the unqueried first page when the query is cleared', async () => {
    const { queryPage } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('unqueried evidence')

    type('first')
    await screen.findByText('queried evidence')
    queryPage.mockClear()

    type('')
    await screen.findByText('unqueried evidence')
    expect(screen.queryByText('queried evidence')).toBeNull()
    expect(queryPage.mock.calls.every((c) => c[0].cursor == null)).toBe(true)
  })
})
