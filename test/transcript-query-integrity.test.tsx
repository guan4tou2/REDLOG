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

function installBridge(counterparts: unknown[] = []): { toolCounterparts: ReturnType<typeof vi.fn>; runQuery: ReturnType<typeof vi.fn> } {
  const toolCounterparts = vi.fn().mockResolvedValue(counterparts)
  const runQuery = vi.fn().mockImplementation((req: { filter: { agentType: string } }) =>
    Promise.resolve(req.filter.agentType === 'agent' ? { ...empty, items: [call] } : empty))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((req: { agentType: string }) =>
        Promise.resolve(req.agentType === 'agent' ? { ...empty, items: [call] } : empty)),
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

  it('shows source and receipt time as separate evidence properties', async () => {
    installBridge([result])
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    expect(await screen.findByTestId('transcript-source-time')).not.toBeNull()
    expect(screen.getByTestId('transcript-receipt-time')).not.toBeNull()
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
