// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/EventContentReader', () => ({ EventContentReader: () => <div>saved-reader</div> }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const empty = { items: [], hasMore: false, nextCursor: null }
const tool = (id: string, data: Record<string, unknown>) => ({
  id, timestamp: 1_000, createdAt: 2_000, engagementId: 'project', sessionId: 'binding', operatorId: 'op', agentType: 'agent', targetId: null,
  data: { agent: 'opencode', session_id: 'ses_1', tool: 'bash', tool_input: { command: 'nmap -sV 10.10.10.5' }, ...data }
})

function install(items: unknown[]): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((req: { agentType: string }) => Promise.resolve(req.agentType === 'agent' ? { ...empty, items } : empty)),
      runQuery: vi.fn().mockResolvedValue(empty),
      toolCounterparts: vi.fn().mockResolvedValue([]), onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Transcript: a tool run reported as one event (#546)', () => {
  it('shows an opencode_tool event with output_preview as one exchange with its output', async () => {
    install([tool('t1', { subtype: 'opencode_tool', output_preview: 'Starting Nmap 7.94\n22/tcp open ssh' })])
    render(<TranscriptView reading="ai" />)
    expect(await screen.findByText(/22\/tcp open ssh/)).not.toBeNull()
    expect(screen.getAllByTestId('transcript-toggle')).toHaveLength(1)
  })

  it('says the output was not captured, rather than dropping the row, when there is no output_preview', async () => {
    install([tool('t2', { subtype: 'codex_tool' })])
    render(<TranscriptView />)
    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(await screen.findByText('transcript.note.uncaptured')).not.toBeNull()
  })
})
