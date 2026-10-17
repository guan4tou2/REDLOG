import { describe, expect, it } from 'vitest'
import { countPauseWindows, countTruncatedOutputs } from '../src/core/export-plan'
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

  it('does not count complete output', () => {
    expect(countTruncatedOutputs([
      ev('terminal', { stdout_truncated: false }),
      ev('terminal', { io: { truncated: false } }),
      ev('http', { response_body_ref: { sha256: 'a' } }),
      ev('terminal', {})
    ])).toBe(0)
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
