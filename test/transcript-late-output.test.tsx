// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'

// A command whose prompt came back before it finished keeps printing. The
// transcript reads that as one command: the later output is in its block, and
// nothing is said about it while it is whole. Only output that is still
// arriving, or that lost bytes, is flagged.

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
const commandEnd = {
  id: 'end-1', timestamp: 1, operatorId: 'op', agentType: 'shell', targetId: null,
  data: { subtype: 'command_end', command: 'nmap -p- 10.0.0.7 &', command_id: 'c1', exit_code: 0,
    stdout: 'early\n', late_output: true }
}

function install(rows: unknown[]): ReturnType<typeof vi.fn> {
  const queryPage = vi.fn().mockImplementation((opts: { agentType: string }) =>
    Promise.resolve(opts.agentType === 'shell' ? { items: [commandEnd], hasMore: false, nextCursor: null } : emptyPage))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, commandOutput: vi.fn().mockResolvedValue(rows), onNewBatch: () => () => {} },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('') }
  }
  return queryPage
}

describe('Transcript background output', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('says nothing extra once the background output finished whole', async () => {
    install([
      { id: 'a', data: { seq: 1, late: true, stdout: 'open 22\n' } },
      { id: 'f', data: { seq: 2, late: true, final: true, late_bytes: 8 } }
    ])
    render(<TranscriptView />)
    await screen.findByText('$ nmap -p- 10.0.0.7 &')
    await waitFor(() => expect(window.redlog.events.commandOutput).toHaveBeenCalledWith('c1'))
    // Let the summary land; "no note" only means something after it has.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByText(/transcript\.metaLate/)).toBeNull()
  })

  it('flags output that is still arriving', async () => {
    install([{ id: 'a', data: { seq: 1, late: true, stdout: 'open 22\n' } }])
    render(<TranscriptView />)
    expect((await screen.findByText(/transcript\.metaLateRunning/))).not.toBeNull()
  })

  it('flags output that lost bytes', async () => {
    install([
      { id: 'a', data: { seq: 1, late: true, stdout: 'open 22\n' } },
      { id: 'f', data: { seq: 2, late: true, final: true, dropped_bytes: 50 } }
    ])
    render(<TranscriptView />)
    expect((await screen.findByText(/transcript\.metaLateIncomplete/))).not.toBeNull()
  })

  it('does not let chunk rows take the shell page, and does not ask for an ordinary command', async () => {
    const queryPage = install([])
    render(<TranscriptView />)
    await screen.findByText('$ nmap -p- 10.0.0.7 &')
    expect(queryPage).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'shell', excludeHousekeeping: true }))
  })
})
