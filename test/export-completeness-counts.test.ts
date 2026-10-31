import { describe, expect, it } from 'vitest'
import { countInterrupted, countPauseWindows, countTruncatedOutputs } from '../src/core/export-plan'
import type { RedLogEvent } from '../src/core/db/event-types'

// The export preview must say when what a reader sees is not all of what
// happened: output cut short at capture, and stretches nothing was recorded.

const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent =>
  ({ id: Math.random().toString(36), agentType, data, targetId: null } as unknown as RedLogEvent)

describe('countTruncatedOutputs', () => {
  it('counts each Event once, whichever field says it was cut', () => {
    expect(countTruncatedOutputs([
      ev('terminal', { stdout_truncated: true, stderr_truncated: true }),
      ev('terminal', { stderr_truncated: true }),
      ev('terminal', { io: { truncated: true } }),
      ev('http', { response_body_ref: { sha256: 'a', truncated: true } }),
      ev('http', { truncated: true })
    ])).toBe(5)
  })

  it('counts observed stream capture loss without turning unknown delivery into proven loss', () => {
    expect(countTruncatedOutputs([
      ev('scanner', { stream_not_queued_bytes: 64 }),
      ev('scanner', { stream_state: 'interrupted' }),
      ev('scanner', { capture_delivery: 'unknown', stream_not_queued_bytes: 0 })
    ])).toBe(2)
  })

  it('does not count complete output', () => {
    expect(countTruncatedOutputs([
      ev('terminal', { stdout_truncated: false }),
      ev('terminal', { io: { truncated: false } }),
      ev('http', { response_body_ref: { sha256: 'a' } }),
      ev('terminal', {})
    ])).toBe(0)
  })
})

// #290: a terminal recording the app never closed, and a command it left
// running, are in the export as what they are: cut off, not finished.
describe('countInterrupted', () => {
  it('counts recordings recovered after a crash and the commands they left open', () => {
    expect(countInterrupted([
      ev('shell', { subtype: 'session_end', source: 'builtin-terminal', recovered: true, reason: 'recovered-orphan' }),
      ev('shell', { subtype: 'session_end', source: 'builtin-terminal', reason: 'shell-exited', exitCode: 0 }),
      ev('shell', { subtype: 'command_boundary', reason: 'recovered-orphan', command_id: 'a' }),
      ev('shell', { subtype: 'command_boundary', reason: 'recovered-orphan', command_id: 'b' }),
      ev('shell', { subtype: 'command_boundary', reason: 'project-switched', command_id: 'c' }),
      ev('system', { subtype: 'session_end', recovered: true })
    ])).toEqual({ recordings: 1, commands: 2 })
  })
})

describe('countPauseWindows', () => {
  it('counts pauses, not resumes or other system Events', () => {
    expect(countPauseWindows([
      ev('system', { subtype: 'recording_paused' }),
      ev('system', { subtype: 'recording_resumed' }),
      ev('system', { subtype: 'config_changed' }),
      ev('terminal', { subtype: 'recording_paused' }),
      ev('system', { subtype: 'recording_paused' })
    ])).toBe(2)
  })
})
