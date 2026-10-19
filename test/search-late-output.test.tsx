// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchPanel } from '../src/renderer/src/components/SearchPanel'

// What a background command printed after its prompt came back is stored as
// rows the Timeline hides. A search hit inside it must open the command, which
// is the row the Timeline has, and must not list the command once per chunk.

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({
    filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const base = {
  timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op', agentType: 'shell',
  hostname: 'host', sourceIP: null, targetId: null, hash: 'h', prevHash: null, createdAt: 1
}
const chunk = (id: string, seq: number, commandId = 'c1') => ({
  ...base, id, data: { subtype: 'command_output', command_id: commandId, seq, late: true, stdout: 'needle\n' }
})
const commandEnd = { ...base, id: 'end-1', data: { subtype: 'command_end', command: 'nmap -p- 10.0.0.7 &', command_id: 'c1', late_output: true } }

function install(items: unknown[], ends: unknown[]): ReturnType<typeof vi.fn> {
  const runQuery = vi.fn().mockResolvedValue({ items, hasMore: false, nextCursor: null })
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      runQuery, searchCasts: vi.fn().mockResolvedValue([]),
      castIndexStatus: vi.fn().mockResolvedValue({ pending: 0 }),
      distinctAgentTypes: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue([]),
      commandEnds: vi.fn().mockResolvedValue(ends)
    },
    marker: { amendments: vi.fn().mockResolvedValue([]) }
  }
  return runQuery
}

async function search(runQuery: ReturnType<typeof vi.fn>): Promise<void> {
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'needle' } })
  await waitFor(() => expect(runQuery).toHaveBeenCalled(), { timeout: 1500 })
}

describe('Search hits in background output', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('shows the command once for several chunk hits, and opens the command', async () => {
    const runQuery = install([chunk('a', 1), chunk('b', 2)], [commandEnd])
    const open = vi.fn()
    render(<SearchPanel onOpenInTimeline={open} />)
    await search(runQuery)

    const rows = await screen.findAllByText('$ nmap -p- 10.0.0.7 &')
    expect(rows).toHaveLength(1)
    fireEvent.click(rows[0])
    expect(open).toHaveBeenCalledWith('end-1', 1)
    expect(window.redlog.events.commandEnds).toHaveBeenCalledWith(['c1'])
  })

  it('does not list the command twice when it matched as well', async () => {
    const runQuery = install([commandEnd, chunk('a', 1)], [commandEnd])
    render(<SearchPanel />)
    await search(runQuery)
    expect(await screen.findAllByText('$ nmap -p- 10.0.0.7 &')).toHaveLength(1)
  })

  it('keeps a chunk whose command cannot be found', async () => {
    const runQuery = install([chunk('a', 1, 'gone')], [])
    render(<SearchPanel />)
    await search(runQuery)
    await waitFor(() => expect(screen.queryByTestId('search-error')).toBeNull())
    expect(await screen.findByLabelText('search.resultsLabel')).not.toBeNull()
  })
})
