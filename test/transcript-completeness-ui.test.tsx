// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'

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

const clipboardWrite = vi.fn().mockResolvedValue(true)

function installBridge(queryPage: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, onNewBatch: () => () => {} },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    // Copy goes through the main process, not navigator.clipboard — the
    // renderer's permission handler denies the Async Clipboard API.
    clipboard: { writeText: clipboardWrite, readText: vi.fn().mockResolvedValue('') }
  }
}

describe('Transcript completeness UI', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('renders an initial query rejection as a retryable failure, not empty', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('database unavailable')))
    render(<TranscriptView />)

    expect(await screen.findByTestId('transcript-load-error')).not.toBeNull()
    expect(screen.queryByText('transcript.empty')).toBeNull()
    expect(screen.getByRole('button', { name: 'common.retry' })).not.toBeNull()
  })

  it('retains loaded evidence and incompleteness after an older-page failure', async () => {
    const queryPage = vi.fn().mockImplementation((opts: { agentType: string; cursor?: string }) => {
      if (opts.cursor) return Promise.reject(new Error('older page unavailable'))
      if (opts.agentType === 'agent') return Promise.resolve({ items: [event], hasMore: true, nextCursor: 'agent-cursor' })
      return Promise.resolve(emptyPage)
    })
    installBridge(queryPage)
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')
    fireEvent.click(screen.getByRole('button', { name: 'transcript.loadOlder' }))

    expect(await screen.findByTestId('transcript-load-error')).not.toBeNull()
    expect(screen.getByText('loaded evidence')).not.toBeNull()
    expect(screen.getByTestId('transcript-completeness').textContent).toBe('transcript.recentSubset')
  })

  it('discloses a partial dataset in copied Markdown', async () => {
    installBridge(vi.fn().mockImplementation((opts: { agentType: string }) =>
      Promise.resolve(opts.agentType === 'agent'
        ? { items: [event], hasMore: true, nextCursor: 'agent-cursor' }
        : emptyPage)))
    render(<TranscriptView />)
    await screen.findByText('loaded evidence')
    fireEvent.click(screen.getByRole('button', { name: 'transcript.copyMd' }))

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled())
    expect(clipboardWrite.mock.calls[0][0]).toContain('transcript.partialMarkdown')
  })
})
