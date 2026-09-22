// @vitest-environment jsdom

// The FilterBar is global, so a chip stays lit on views that cannot honour it.
// Two views narrow the data by construction, and each used to answer a filtered
// question with unfiltered or empty results and no way to tell:
//
//   HTTP History pins the query's agentType to the proxy's source type, so a
//   type chip set to anything else was silently overridden — the panel even
//   re-queried on the chip change and returned the same rows.
//
//   The Transcript buckets a fixed set of source types. A type outside that
//   set produced zero queries and an empty screen indistinguishable from
//   "the project holds no such events".
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const sharedFilter: {
  targetId: string | null
  agentType: string | null
  timeRange: null
  inScopeOnly: boolean
} = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: sharedFilter }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn(), toastDeferred: vi.fn() }))
vi.mock('../src/renderer/src/lib/exportScope', () => ({ useContributeExport: () => {} }))

const emptyPage = { items: [], hasMore: false, nextCursor: null }

function installBridge(queryPage: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage,
      queryHttpFlowPage: queryPage,
      onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
}

afterEach(() => {
  cleanup()
  sharedFilter.agentType = null
  vi.clearAllMocks()
})

describe('unapplied shared filter conditions', () => {
  it('HTTP History states that a non-proxy type chip is not applied', async () => {
    sharedFilter.agentType = 'agent'
    installBridge(vi.fn().mockResolvedValue(emptyPage))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    expect(await screen.findByTestId('unapplied-filter-notice')).not.toBeNull()
  })

  it('HTTP History shows no notice when the type chip matches what it records', async () => {
    sharedFilter.agentType = 'scanner'
    installBridge(vi.fn().mockResolvedValue(emptyPage))
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    await waitFor(() => expect(screen.getByTestId('http-completeness')).not.toBeNull())
    expect(screen.queryByTestId('unapplied-filter-notice')).toBeNull()
  })

  it('HTTP History asks for nothing rather than answering with the wrong type', async () => {
    sharedFilter.agentType = 'agent'
    const queryPage = vi.fn().mockResolvedValue(emptyPage)
    installBridge(queryPage)
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    // The panel empties itself instead of substituting its own source type,
    // so the notice is the only thing that accounts for the empty list.
    expect(await screen.findByTestId('unapplied-filter-notice')).not.toBeNull()
    expect(queryPage).not.toHaveBeenCalled()
  })

  it('HTTP History queries its own source type once the chip agrees', async () => {
    sharedFilter.agentType = 'scanner'
    const queryPage = vi.fn().mockResolvedValue(emptyPage)
    installBridge(queryPage)
    const { HttpHistoryPanel } = await import('../src/renderer/src/components/HttpHistoryPanel')
    render(<HttpHistoryPanel />)

    await waitFor(() => expect(queryPage).toHaveBeenCalled())
    expect(queryPage.mock.calls[0][0].agentType).toBe('scanner')
  })

  it('Transcript explains an untracked type instead of looking empty', async () => {
    sharedFilter.agentType = 'http'
    const queryPage = vi.fn().mockResolvedValue(emptyPage)
    installBridge(queryPage)
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    expect(await screen.findByTestId('unapplied-filter-notice')).not.toBeNull()
    // No bucket matched, so there was nothing to ask the database for; the
    // empty screen must not be attributed to an answered query.
    expect(queryPage).not.toHaveBeenCalled()
  })

  it('Transcript keeps its ordinary empty state for a type it does bucket', async () => {
    sharedFilter.agentType = 'agent'
    installBridge(vi.fn().mockResolvedValue(emptyPage))
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)

    await waitFor(() => expect(screen.getByText('transcript.empty')).not.toBeNull())
    expect(screen.queryByTestId('unapplied-filter-notice')).toBeNull()
  })
})
