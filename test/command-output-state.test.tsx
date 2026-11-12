// @vitest-environment jsdom
//
// #591: the same command_end must say the same thing about its output in every
// reader. The Timeline said "nothing recorded" for a command that printed
// nothing while the transcript called it "not captured"/"not bracketed", and a
// large output saved by reference read as "not captured" in the transcript.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TranscriptView from '../src/renderer/src/components/TranscriptView'
import { IoAbsenceNote } from '../src/renderer/src/components/TimelineEventDetails'
import { commandOutputState, responseBodyState, type CommandOutputState } from '../src/core/content-contract'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

afterEach(cleanup)

const base = { subtype: 'command_end', command: 'ls', command_id: 'c1', exit_code: 0 }
const ref = { sha256: 'a'.repeat(64), size: 9, file: 'x', encoding: 'text' }
const CASES: Array<[string, Record<string, unknown>, CommandOutputState]> = [
  ['inline stdout', { ...base, stdout: 'hi\n' }, 'inline'],
  ['stdout cut at the cap', { ...base, stdout: '', stdout_bytes: 5000, stdout_truncated: true }, 'inline'],
  ['saved by reference', { ...base, stdout_ref: ref }, 'saved'],
  ['bracketed span with bytes', { ...base, source: 'builtin-terminal', io: { off: 0, len: 42 } }, 'recorded'],
  ['bracketed span, nothing printed', { ...base, source: 'builtin-terminal', io: { off: 0, len: 0 } }, 'empty'],
  ['built-in terminal, no span', { ...base, source: 'builtin-terminal' }, 'unbracketed'],
  ['unbracketed span', { ...base, source: 'builtin-terminal', io: { off: 0, len: 9, unbracketed: true } }, 'unbracketed'],
  // Empty is the producer's claim, not an inference from empty strings: the
  // relay writes the same strings when it never ran (report 10, A.4 #1).
  ['captured empty stdout', { ...base, stdout: '', stderr: '', completeness: 'complete', output_disposition: 'captured' }, 'empty'],
  ['empty strings, no producer statement', { ...base, stdout: '', stderr: '' }, 'unknown'],
  ['relay never held the output', { ...base, stdout: '', stderr: '', completeness: 'metadata-only', output_disposition: 'not-captured' }, 'not-captured'],
  ['external shell', { ...base, source: 'auto-relay' }, 'not-captured']
]

describe('commandOutputState', () => {
  it.each(CASES)('%s → %s', (_name, data, expected) => {
    expect(commandOutputState(data)).toBe(expected)
  })
})

// What each state is called on screen, per reader. A reader that has no absence
// note for a state (inline text, a saved reference with its own button) is not
// listed.
const TRANSCRIPT_KEY: Partial<Record<CommandOutputState, string>> = {
  recorded: 'transcript.note.recorded', empty: 'content.empty', saved: 'transcript.note.saved',
  unbracketed: 'transcript.note.unbracketed', 'not-captured': 'transcript.note.uncaptured',
  unknown: 'content.output.unknown'
}
const TIMELINE_KEY: Partial<Record<CommandOutputState, string>> = {
  recorded: 'timeline.detail.ioOnDisk', empty: 'content.empty',
  unbracketed: 'timeline.detail.ioUnbracketed', 'not-captured': 'timeline.detail.ioNotCaptured',
  unknown: 'content.output.unknown'
}

function installTranscript(data: Record<string, unknown>) {
  const ev = { id: 'end-1', timestamp: 1, operatorId: 'op', agentType: 'shell', targetId: null, data }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage: vi.fn().mockImplementation((o: { agentType: string }) =>
        Promise.resolve(o.agentType === 'shell' ? { items: [ev], hasMore: false, nextCursor: null } : { items: [], hasMore: false, nextCursor: null })),
      commandOutput: vi.fn().mockResolvedValue({ items: [], hasMore: false }), onNewBatch: () => () => {}
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('') }
  }
}

describe('one command_end, one answer in every reader', () => {
  it.each(CASES.filter(([, , state]) => TRANSCRIPT_KEY[state]))('transcript: %s', async (_name, data, state) => {
    installTranscript(data)
    render(<TranscriptView />)
    await screen.findByText('$ ls')
    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(await screen.findByText(new RegExp(TRANSCRIPT_KEY[state]!.replace('.', '\\.')))).toBeTruthy()
  })

  // `inline` with no text to show: the relay strips terminal control sequences
  // and can be left with '' while the byte count says output existed. Matching
  // no render branch, the row used to show neither output nor a note.
  it.each([
    ['stdout cut at the cap, no text left', { ...base, stdout: '', stdout_bytes: 5000, stdout_truncated: true }],
    ['stdout stripped to nothing', { ...base, stdout: '', stderr: '', stdout_bytes: 12, stderr_bytes: 0 }],
    ['stderr stripped to nothing', { ...base, stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 7 }]
  ])('transcript: inline with no text still says where the output is: %s', async (_name, data) => {
    expect(commandOutputState(data)).toBe('inline')
    installTranscript(data)
    render(<TranscriptView />)
    await screen.findByText('$ ls')
    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(await screen.findByText(/transcript\.note\.saved/)).toBeTruthy()
  })

  it.each(CASES.filter(([, , state]) => TIMELINE_KEY[state]))('timeline: %s', (_name, data, state) => {
    render(<IoAbsenceNote data={data} builtin={data.source === 'builtin-terminal'} io={data.io as Record<string, unknown> | undefined} />)
    expect(screen.getByText(new RegExp(TIMELINE_KEY[state]!.replace('.', '\\.')))).toBeTruthy()
  })
})

describe('an HTTP response body', () => {
  it.each([
    ['a preview', { response_preview: 'hello' }, 'inline'],
    ['a stored body by reference', { response_body_ref: { sha256: 'a'.repeat(64), size: 9, file: 'x', encoding: 'text' } }, 'saved'],
    ['an inline body', { response_body: { data: 'x', encoding: 'text', size: 1 } }, 'saved'],
    ['a declared length of 0', { content_length: 0 }, 'empty'],
    ['nothing at all', {}, 'not-captured']
  ])('%s', (_name, data, expected) => {
    expect(responseBodyState(data as Record<string, unknown>)).toBe(expected)
  })

  it('the transcript calls a stored body saved, not "not captured"', async () => {
    const req = { id: 'r1', timestamp: 1, operatorId: 'op', agentType: 'scanner', targetId: null, data: { subtype: 'http_request_start', method: 'GET', url: 'https://t.test/', flow_id: 'f1' } }
    const res = { id: 'r2', timestamp: 2, operatorId: 'op', agentType: 'scanner', targetId: null, data: { subtype: 'http_response', flow_id: 'f1', status: 200, response_body_ref: { sha256: 'a'.repeat(64), size: 9, file: 'x', encoding: 'text' } } }
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: {
        queryPage: vi.fn().mockImplementation((o: { agentType: string }) =>
          Promise.resolve(o.agentType === 'scanner' ? { items: [res, req], hasMore: false, nextCursor: null } : { items: [], hasMore: false, nextCursor: null })),
        commandOutput: vi.fn().mockResolvedValue({ items: [], hasMore: false }), onNewBatch: () => () => {}
      },
      operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
      clipboard: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('') }
    }
    render(<TranscriptView />)
    await screen.findByText(/GET https:\/\/t\.test\//)
    fireEvent.click(await screen.findByTestId('transcript-toggle'))
    expect(await screen.findByText(/transcript\.note\.saved/)).toBeTruthy()
  })
})
