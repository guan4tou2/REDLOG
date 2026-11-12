// @vitest-environment jsdom
//
// Report 10 (2026-11-12) A.4 #1 / E.4: the relay and the shell hooks say what
// became of a command's output (`output_disposition`, `completeness`), and the
// readers did not read it — a relay that never ran, output sent to a file and a
// lost drain all read as "No content was produced." Each state the producers
// write is named here, per reader, from the producer's own words.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { commandOutputState, type CommandOutputState } from '../src/core/content-contract'
import { IoAbsenceNote } from '../src/renderer/src/components/TimelineEventDetails'
import { EventContentReader } from '../src/renderer/src/components/EventContentReader'
import { ioMark } from '../src/renderer/src/lib/timelineDomain'
import { OUTPUT_NOTE_KEY } from '../src/renderer/src/lib/commandOutputNote'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))
afterEach(cleanup)

const base = { subtype: 'command_end', command: 'nmap -oN x 10.0.0.5', command_id: 'c1', exit_code: 0 }
const ref = { sha256: 'a'.repeat(64), size: 9, file: 'x', encoding: 'text' }

// Shapes copied from what each producer writes (file:line of the writer).
const CASES: Array<[string, Record<string, unknown>, CommandOutputState]> = [
  // hooks/redlog-relay.py emit(): the command never started → nothing held.
  ['relay: never held (not-captured)', { ...base, stdout: '', stderr: '', stdout_bytes: 0, completeness: 'metadata-only', output_disposition: 'not-captured' }, 'not-captured'],
  // hooks/redlog-relay.py finish(): `> file` with no bytes on stdout.
  ['relay: redirected', { ...base, stdout: '', stderr: '', stdout_bytes: 0, completeness: 'metadata-only', output_disposition: 'redirected' }, 'redirected'],
  // hooks/shell-zsh-hook.zsh / shell-bash-hook.sh: class native|pty, no relay.
  ['hook: interactive program', { ...base, completeness: 'metadata-only', output_disposition: 'interactive' }, 'interactive'],
  // hooks/redlog-relay.py finish(): a part never arrived (drain-timeout).
  ['relay: drain timeout', { ...base, stdout: '', stderr: '', stdout_bytes: 0, completeness: 'truncated', output_disposition: 'captured', limit_hit: 'drain-timeout' }, 'incomplete'],
  // A captured, complete, empty run — the one case that is "nothing printed".
  ['relay: complete and empty', { ...base, stdout: '', stderr: '', stdout_bytes: 0, completeness: 'complete', output_disposition: 'captured' }, 'empty'],
  // An older row, or a producer that never said: empty strings prove nothing.
  ['no disposition fields, empty strings', { ...base, stdout: '', stderr: '' }, 'unknown'],
  // src/main/services/powershell-transcript.ts: output arrives as output_preview.
  ['PowerShell transcript with output', { ...base, source: 'start-transcript', output_preview: 'Directory: C:\\' }, 'inline'],
  ['PowerShell transcript without output', { ...base, source: 'start-transcript' }, 'unknown'],
  // Unchanged states keep their answer.
  ['inline text', { ...base, stdout: 'open 22/tcp', completeness: 'complete', output_disposition: 'captured' }, 'inline'],
  ['saved by reference', { ...base, stdout_ref: ref }, 'saved'],
  ['built-in, bracketed, nothing printed', { ...base, source: 'builtin-terminal', io: { off: 0, len: 0 } }, 'empty'],
  ['built-in, project boundary', { ...base, source: 'builtin-terminal', completeness: 'partial', output_disposition: 'project-boundary' }, 'unbracketed']
]

describe('commandOutputState reads what the producer said', () => {
  it.each(CASES)('%s → %s', (_name, data, expected) => {
    expect(commandOutputState(data)).toBe(expected)
  })
})

describe('the Timeline note names each state', () => {
  it.each(CASES.filter(([, , s]) => !['inline', 'saved'].includes(s)))('%s', (_name, data, state) => {
    render(<IoAbsenceNote data={data} builtin={data.source === 'builtin-terminal'} io={data.io as Record<string, unknown> | undefined} />)
    expect(screen.getByText(new RegExp(OUTPUT_NOTE_KEY[state]!.replace(/\./g, '\\.')))).toBeTruthy()
  })

  it('never calls an uncaptured command empty', () => {
    for (const [, data, state] of CASES) if (state !== 'empty') expect(OUTPUT_NOTE_KEY[state]).not.toBe('content.empty')
  })
})

describe('the track marks uncaptured output apart from no output', () => {
  const ev = (data: Record<string, unknown>) => ({ id: 'e', timestamp: 1, agentType: 'shell', data }) as unknown as RedLogEvent
  it.each(CASES)('%s', (_name, data, state) => {
    const io = ioMark(ev(data)).io
    if (state === 'empty') expect(io).toBeNull()
    else if (['inline', 'saved', 'recorded'].includes(state)) expect(io).toBe('recorded')
    else expect(io).toBe('uncaptured')
  })
})

describe('the saved-content reader does not call a lost stdout empty', () => {
  it.each([
    ['not-captured', 'timeline.detail.ioNotCaptured'],
    ['redirected', 'content.output.redirected'],
    ['unknown', 'content.output.unknown'],
    ['empty', 'content.empty']
  ] as const)('%s', async (state, key) => {
    const stdout = { field: 'stdout', status: 'available', bytes: 0, format: 'utf8', capture: 'unknown', ref: { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' } }
    ;(window as unknown as { redlog: unknown }).redlog = { content: {
      list: vi.fn().mockResolvedValue({ ok: true, value: [stdout] }),
      read: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0, end: 0, total: 0, text: '', format: 'utf8', hasMore: false, nextCursor: null } })
    } }
    render(<EventContentReader projectId="p" eventId="e" outputState={state} />)
    await waitFor(() => expect(screen.getByText(key)).toBeTruthy())
    if (state !== 'empty') expect(screen.queryByText('content.empty')).toBeNull()
  })
})
