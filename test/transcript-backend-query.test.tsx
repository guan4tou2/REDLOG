// @vitest-environment jsdom
//
// Spec 017 T012. The Transcript's text box used to filter the blocks it had
// already loaded, so an empty result meant "not in what you have loaded" while
// reading as "not in this engagement". These assert the box now asks the store,
// which is the whole point of the feature, and that it stops filtering twice.

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

const emptyPage = { items: [], hasMore: false, nextCursor: null }
const event = {
  id: 'agent-1', timestamp: 1, operatorId: 'op', agentType: 'agent', targetId: null,
  data: { subtype: 'assistant_message', agent: 'codex', full: 'loaded evidence' }
}

function installBridge(): { queryPage: ReturnType<typeof vi.fn>; runQuery: ReturnType<typeof vi.fn> } {
  const queryPage = vi.fn().mockImplementation((opts: { agentType: string }) =>
    Promise.resolve(opts.agentType === 'agent' ? { ...emptyPage, items: [event] } : emptyPage))
  const runQuery = vi.fn().mockResolvedValue(emptyPage)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, runQuery, toolCounterparts: vi.fn().mockResolvedValue([]), onNewBatch: () => () => {} },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
  return { queryPage, runQuery }
}

async function typeQuery(text: string): Promise<void> {
  const box = await screen.findByPlaceholderText(/transcript\.(search|filter)/i)
    .catch(() => screen.getByRole('textbox'))
  fireEvent.change(box, { target: { value: text } })
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers() })

describe('Transcript queries the store, not the loaded blocks (T012)', () => {
  it('loads without a query through the plain paged read', async () => {
    const { queryPage, runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    await screen.findByText('loaded evidence')
    expect(queryPage).toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('sends a typed term to the store instead of filtering what is loaded', async () => {
    const { runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')

    await typeQuery('refused')

    await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 3000 })
    const req = runQuery.mock.calls[0][0]
    expect(req.parsed.text).toBe('refused')
    expect(req.parsed.conditions).toEqual([])
  })

  it('carries each bucket as a filter so per-type balance survives the query', async () => {
    const { runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')

    await typeQuery('refused')

    await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 3000 })
    const types = runQuery.mock.calls.map((c) => c[0].filter.agentType)
    expect(types).toContain('agent')
    expect(types).toContain('shell')
    // Each bucket keeps its own limit, which is what stops one high-volume
    // type from starving the others once a query narrows the set.
    expect(runQuery.mock.calls.every((c) => typeof c[0].limit === 'number')).toBe(true)
  })

  it('sends an identifier condition as a condition, not as text', async () => {
    const { runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')

    await typeQuery('session:S1')

    await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 3000 })
    const req = runQuery.mock.calls[0][0]
    expect(req.parsed.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(req.parsed.text).toBe('')
  })

  it('never sends a half-typed condition to the store', async () => {
    const { runQuery } = installBridge()
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')

    await typeQuery('session:')

    // Give the debounce more than its window; nothing should reach the store.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(runQuery).not.toHaveBeenCalled()
  })
})
