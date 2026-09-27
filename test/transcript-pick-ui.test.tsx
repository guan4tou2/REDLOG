// @vitest-environment jsdom
// #225: picking a step records a marker citing it (the step itself is not
// edited), "picked only" narrows the view to picked steps, and one step can
// be copied with its provenance.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

const shell = (id: string, command: string, ts: number): unknown => ({
  id, timestamp: ts, operatorId: 'op', agentType: 'shell', targetId: '10.0.0.5',
  data: { subtype: 'command_end', command, stdout: `${command} output\nline 2`, exit_code: 0, terminalId: 't1' }
})

let markers: unknown[] = []
const markerCreate = vi.fn()
const clipboardWrite = vi.fn().mockResolvedValue(true)

beforeEach(() => {
  vi.clearAllMocks()
  markers = []
  markerCreate.mockImplementation(async (data: { causes: string[]; category: string }) => {
    const ev = { id: `m${markers.length}`, timestamp: 5, operatorId: 'op', agentType: 'marker', targetId: '10.0.0.5', data: { title: 'x', category: data.category, _causes: data.causes } }
    markers.push(ev)
    return ev
  })
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((opts: { agentType: string }) => Promise.resolve({
        items: opts.agentType === 'shell' ? [shell('s1', 'id', 1), shell('s2', 'whoami', 2)] : opts.agentType === 'marker' ? [...markers] : [],
        hasMore: false, nextCursor: null
      })),
      onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([]) },
    marker: { create: markerCreate },
    clipboard: { writeText: clipboardWrite, readText: vi.fn().mockResolvedValue('') }
  }
})
afterEach(cleanup)

describe('picking steps in the transcript', () => {
  it('records a marker citing the step, then shows only picked steps', async () => {
    render(<TranscriptView />)
    await screen.findByText('$ whoami')
    fireEvent.click(screen.getAllByTestId('transcript-pick')[1])
    fireEvent.click(screen.getByTestId('transcript-pick-failed_attempt'))
    await waitFor(() => expect(markerCreate).toHaveBeenCalledTimes(1))
    expect(markerCreate.mock.calls[0][0]).toMatchObject({ category: 'failed_attempt', causes: ['s2'], targetId: '10.0.0.5', atTimestamp: 2 })

    await screen.findByTestId('transcript-pick-badge')
    fireEvent.click(screen.getByTestId('transcript-picked-only'))
    await waitFor(() => expect(screen.queryByText('$ id')).toBeNull())
    expect(screen.getByText('$ whoami')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'transcript.copyMd' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled())
    const md = clipboardWrite.mock.calls[0][0] as string
    expect(md).toContain('transcript.selectionPicked')
    expect(md).toContain('whoami')
    expect(md).not.toContain('$ id\n')
  })

  it('copies one step whole, with its provenance', async () => {
    render(<TranscriptView />)
    await screen.findByText('$ id')
    fireEvent.click(screen.getAllByTestId('transcript-copy-step')[0])
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled())
    const md = clipboardWrite.mock.calls[0][0] as string
    expect(md).toContain('snippet.events: `s1`')
    expect(md).toContain('snippet.session: `t1`')
    expect(md).toContain('id output\nline 2')
  })
})
