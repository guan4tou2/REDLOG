// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const empty = { items: [], hasMore: false, nextCursor: null }
const call = {
  id: 'call-1', timestamp: 1_000, createdAt: 2_000, operatorId: 'op', agentType: 'agent', targetId: null,
  data: { subtype: 'tool_call', agent: 'codex', session_id: 'S1', tool_use_id: 'T1', tool_name: 'shell', tool_input: { command: 'id' } }
}
const result = {
  id: 'result-1', timestamp: 1_500, createdAt: 2_500, operatorId: 'op', agentType: 'agent', targetId: null,
  data: { subtype: 'tool_result', agent: 'codex', session_id: 'S1', tool_use_id: 'T1', output: 'uid=0' }
}

function installBridge(
  counterparts: unknown[] = [],
  agentItems: unknown[] = [call]
): { toolCounterparts: ReturnType<typeof vi.fn>; runQuery: ReturnType<typeof vi.fn> } {
  const toolCounterparts = vi.fn().mockResolvedValue(counterparts)
  const runQuery = vi.fn().mockImplementation((req: { filter: { agentType: string } }) =>
    Promise.resolve(req.filter.agentType === 'agent' ? { ...empty, items: agentItems } : empty))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((req: { agentType: string }) =>
        Promise.resolve(req.agentType === 'agent' ? { ...empty, items: agentItems } : empty)),
      runQuery, toolCounterparts, onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
  return { toolCounterparts, runQuery }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Transcript query integrity', () => {
  it('completes all missing tool pairs in one lookup', async () => {
    const { toolCounterparts } = installBridge([result])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(await screen.findByText(/uid=0/)).not.toBeNull()
    expect(toolCounterparts).toHaveBeenCalledTimes(1)
    expect(toolCounterparts).toHaveBeenCalledWith([{ sessionId: 'S1', toolUseId: 'T1' }])
  })

  it('marks a tool half as unresolved when the store has no counterpart', async () => {
    installBridge([])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(screen.getByText(/transcript.note.unpaired/)).not.toBeNull()
  })

  // Spec 017 FR-014 / Domain Invariant #8. The old version of this test
  // asserted only that two nodes existed, which stayed green for as long as
  // both of them rendered the same `Date.now()` — the exact failure it was
  // supposed to catch. These assert the two times can actually come apart,
  // and that the row says so when they do.
  it('keeps source and receipt time distinguishable when a replay pulls them apart', async () => {
    installBridge([result])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    const occurred = await screen.findByTestId('transcript-source-time')
    expect(occurred.getAttribute('data-occurred-at')).toBe(String(call.timestamp))
    const recorded = screen.getByTestId('transcript-receipt-time')
    expect(recorded.getAttribute('data-recorded-at')).toBe(String(call.createdAt))
    expect(occurred.getAttribute('data-occurred-at')).not.toBe(recorded.getAttribute('data-recorded-at'))
  })

  it('shows one time, not the same time twice, for an event captured live', async () => {
    const live = { ...call, timestamp: 4_000, createdAt: 4_000 }
    // No counterpart: `result` sits at 1_500, before this call, so it would not
    // pair with it and would render as a second, unrelated block.
    installBridge([], [live])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    const occurred = await screen.findByTestId('transcript-source-time')
    expect(occurred.getAttribute('data-occurred-at')).toBe('4000')
    expect(screen.queryByTestId('transcript-receipt-time')).toBeNull()
  })

  it('describes completeness against the matching query dataset and labels local kind filtering', async () => {
    installBridge([result])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'uid' } })

    await waitFor(() => expect(screen.getByTestId('transcript-completeness').textContent).toBe('transcript.queryComplete'), { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: 'transcript.kind.shell' }))
    expect(screen.getByTestId('transcript-kind-local').textContent).toBe('transcript.kindLoadedOnly')
  })
})
