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

vi.mock('../src/renderer/src/components/EventContentReader', () => ({ EventContentReader: () => <div>saved-reader</div> }))

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

  it('keeps failed commands bounded and Loot sensitive text folded until requested', async () => {
    const rows = [
      { ...event, id: 'failed', agentType: 'shell', data: { subtype: 'command_end', command: 'scan', exit_code: 2, stdout: 'first output line\n' + 'large output '.repeat(1000) } },
      { ...event, id: 'secret', agentType: 'loot', data: { matches: [{ type: 'password', value: 'SENSITIVE_LOOT' }] } }
    ]
    installBridge(vi.fn().mockImplementation((opts: { agentType: string }) => Promise.resolve({ ...emptyPage, items: rows.filter(row => row.agentType === opts.agentType) })))
    render(<TranscriptView />)
    expect((await screen.findByTestId('transcript-output-preview')).textContent).toBe('first output line')
    expect(screen.getByText('transcript.metaExit')).toBeTruthy()
    expect(screen.queryByText(/large output large output/)).toBeNull()
    expect(screen.queryByText(/SENSITIVE_LOOT/)).toBeNull()
    expect(screen.getAllByTestId('transcript-toggle').every(button => button.getAttribute('data-expanded') === 'false')).toBe(true)
  })

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
  it('replaces the inline output with the saved reader and restores it when closed', async () => {
    const shellEvent = { ...event, id: 'shell-end', engagementId: 'eng', agentType: 'shell',
      data: { subtype: 'command_end', command: 'printf result', stdout: 'shell-output', exit_code: 0 } }
    installBridge(vi.fn().mockImplementation((opts: { agentType: string }) =>
      Promise.resolve(opts.agentType === 'shell' ? { ...emptyPage, items: [shellEvent] } : emptyPage)))
    render(<TranscriptView reading="io" />)
    await screen.findByText('shell-output')
    fireEvent.click(screen.getByRole('button', { name: 'content.savedContent' }))
    expect(await screen.findByText('saved-reader')).toBeTruthy()
    expect(screen.queryByText('shell-output')).toBeNull()
    expect(screen.getByText('$ printf result')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'content.savedContent' }))
    expect(await screen.findByText('shell-output')).toBeTruthy()
  })

})
