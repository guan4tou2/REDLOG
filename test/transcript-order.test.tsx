// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'

// The transcript reads newest first: what just happened is what is looked for.
// Blocks are still built oldest first; the copied Markdown follows the list on
// screen, newest first.

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const shell = (id: string, command: string, ts: number): unknown => ({
  id, timestamp: ts, operatorId: 'op', agentType: 'shell', targetId: null,
  data: { subtype: 'command_end', command, stdout: `${command} out`, exit_code: 0 }
})
const clipboardWrite = vi.fn().mockResolvedValue(true)

function install(hasMore: boolean): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((opts: { agentType: string }) => Promise.resolve({
        // Delivered newest-first by the store; the view must not depend on it.
        items: opts.agentType === 'shell' ? [shell('s3', 'third', 3), shell('s1', 'first', 1), shell('s2', 'second', 2)] : [],
        hasMore: opts.agentType === 'shell' && hasMore, nextCursor: opts.agentType === 'shell' && hasMore ? 'c' : null
      })),
      onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([]) },
    clipboard: { writeText: clipboardWrite, readText: vi.fn().mockResolvedValue('') }
  }
}

const rowOrder = (): string[] =>
  screen.getAllByText(/^\$ (first|second|third)$/).map((el) => el.textContent ?? '')

describe('Transcript order', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('lists the newest step first', async () => {
    install(false)
    render(<TranscriptView />)
    await screen.findByText('$ first')
    expect(rowOrder()).toEqual(['$ third', '$ second', '$ first'])
  })

  it('puts "load older" below the rows, where the older ones will appear', async () => {
    install(true)
    render(<TranscriptView />)
    await screen.findByText('$ first')
    const older = screen.getByRole('button', { name: 'transcript.loadOlder' })
    const lastRow = screen.getByText('$ first')
    expect(lastRow.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const newestRow = screen.getByText('$ third')
    expect(newestRow.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('copies the Markdown in the order shown, newest first', async () => {
    install(false)
    render(<TranscriptView />)
    await screen.findByText('$ first')
    fireEvent.click(screen.getByRole('button', { name: 'transcript.copyMd' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled())
    const md = clipboardWrite.mock.calls[0][0] as string
    expect(md.indexOf('third')).toBeLessThan(md.indexOf('second'))
    expect(md.indexOf('second')).toBeLessThan(md.indexOf('first'))
  })
})
