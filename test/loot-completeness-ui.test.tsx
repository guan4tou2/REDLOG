// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LootPanel } from '../src/renderer/src/components/LootPanel'

const shared = {
  filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
}

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => shared,
  toEventFilter: (filter: typeof shared.filter) => ({
    ...(filter.targetId ? { targetId: filter.targetId } : {}),
    ...(filter.agentType ? { agentType: filter.agentType } : {})
  })
}))

vi.mock('../src/renderer/src/i18n/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const lootEvent = (id: string, preview: string, timestamp: number) => ({
  id, timestamp, operatorId: 'op', agentType: 'loot', targetId: '10.10.10.10',
  data: { source: 'nmap', matches: [{ type: 'generic_api_key', confidence: 'high', preview }] }
})

function installBridge(queryPage: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, onNewBatch: () => () => {} }
  }
}

describe('Loot completeness UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shared.filter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  })
  afterEach(cleanup)

  it('shows a recent subset and loads an older page', async () => {
    const queryPage = vi.fn()
      .mockResolvedValueOnce({ items: [lootEvent('new', 'new secret', 2)], hasMore: true, nextCursor: 'older' })
      .mockResolvedValueOnce({ items: [lootEvent('old', 'old secret', 1)], hasMore: false, nextCursor: null })
    installBridge(queryPage)
    render(<LootPanel />)

    expect(await screen.findByText('new secret')).not.toBeNull()
    expect(screen.getByTestId('loot-completeness').textContent).toBe('loot.recentSubset')
    fireEvent.click(screen.getByRole('button', { name: 'loot.loadOlder' }))

    expect(await screen.findByText('old secret')).not.toBeNull()
    expect(screen.getByTestId('loot-completeness').textContent).toBe('loot.complete')
    expect(queryPage).toHaveBeenLastCalledWith(expect.objectContaining({ agentType: 'loot', cursor: 'older' }))
  })

  it('renders an initial rejection as a retryable failure instead of empty', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('database unavailable')))
    render(<LootPanel />)

    expect(await screen.findByTestId('loot-load-error')).not.toBeNull()
    expect(screen.queryByText('loot.empty')).toBeNull()
    expect(screen.getByRole('button', { name: 'common.retry' })).not.toBeNull()
  })

  it('retains loaded loot and the cursor after an older-page failure', async () => {
    const queryPage = vi.fn()
      .mockResolvedValueOnce({ items: [lootEvent('new', 'retained secret', 2)], hasMore: true, nextCursor: 'older' })
      .mockRejectedValueOnce(new Error('older page unavailable'))
      .mockResolvedValueOnce({ items: [lootEvent('old', 'recovered secret', 1)], hasMore: false, nextCursor: null })
    installBridge(queryPage)
    render(<LootPanel />)
    await screen.findByText('retained secret')
    fireEvent.click(screen.getByRole('button', { name: 'loot.loadOlder' }))

    expect(await screen.findByTestId('loot-load-error')).not.toBeNull()
    expect(screen.getByText('retained secret')).not.toBeNull()
    expect(screen.getByTestId('loot-completeness').textContent).toBe('loot.recentSubset')
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))

    expect(await screen.findByText('recovered secret')).not.toBeNull()
    expect(queryPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'older' }))
  })

  it('does not query loot when the shared source filter excludes it', async () => {
    const queryPage = vi.fn()
    installBridge(queryPage)
    shared.filter = { targetId: null, agentType: 'shell', timeRange: null, inScopeOnly: false }
    render(<LootPanel />)

    await waitFor(() => expect(screen.getByText('loot.empty')).not.toBeNull())
    expect(queryPage).not.toHaveBeenCalled()
  })
})
