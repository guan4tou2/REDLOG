import { describe, expect, it } from 'vitest'
import { countCaptureGaps, countInterrupted, countPauseWindows, countTruncatedOutputs } from '../src/core/export-plan'
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

// #291 R14: a capture_gap is a Known Gap in the record. The export says how
// many fall inside it and, per reason, how much they skipped — and says
// "unknown" where no amount was recorded, never zero. Unconfirmed delivery is
// not a confirmed loss, so it never adds to a skipped total.
describe('countCaptureGaps', () => {
  const gap = (agentType: string, data: Record<string, unknown>): RedLogEvent => ev(agentType, { subtype: 'capture_gap', ...data })

  it('counts each reason on its own, summing the skipped units a gap carries', () => {
    expect(countCaptureGaps([
      gap('scanner', { reason: 'queue-full', skipped_units: 12 }),
      gap('scanner', { reason: 'queue-full', skipped_units: 5 }),
      gap('scanner', { reason: 'project-switched', skipped_units: 3 }),
      gap('system', { reason: 'gap-unsaved', skipped_units: 4 }),
      gap('scanner', { reason: 'delivery-unconfirmed', capture_delivery: 'unknown' })
    ])).toEqual([
      { reason: 'delivery-unconfirmed', gaps: 1, skippedUnits: 0, unknownAmount: 1 },
      { reason: 'gap-unsaved', gaps: 1, skippedUnits: 4, unknownAmount: 0 },
      { reason: 'project-switched', gaps: 1, skippedUnits: 3, unknownAmount: 0 },
      { reason: 'queue-full', gaps: 2, skippedUnits: 17, unknownAmount: 0 }
    ])
  })

  it('counts a pause gap from an AI source, which names no reason, under its own heading', () => {
    expect(countCaptureGaps([gap('system', { agent: 'claude', skipped_bytes: 90, skipped_units: 2 })]))
      .toEqual([{ reason: 'unspecified', gaps: 1, skippedUnits: 2, unknownAmount: 0 }])
  })

  it('does not add unknown delivery into skipped units, whatever the Event claims', () => {
    expect(countCaptureGaps([
      gap('scanner', { reason: 'delivery-unconfirmed', capture_delivery: 'unknown', skipped_units: 9 }),
      gap('scanner', { reason: 'queue-full', capture_delivery: 'unknown', skipped_units: 9 })
    ])).toEqual([
      { reason: 'delivery-unconfirmed', gaps: 1, skippedUnits: 0, unknownAmount: 1 },
      { reason: 'queue-full', gaps: 1, skippedUnits: 0, unknownAmount: 1 }
    ])
  })

  it('shows a gap with no unit count as an unknown amount, not as zero skipped', () => {
    expect(countCaptureGaps([
      gap('scanner', { reason: 'queue-full' }),
      gap('scanner', { reason: 'queue-full', skipped_units: '7' }),
      gap('scanner', { reason: 'queue-full', skipped_units: -1 }),
      gap('scanner', { reason: 'queue-full', skipped_units: 6 })
    ])).toEqual([{ reason: 'queue-full', gaps: 4, skippedUnits: 6, unknownAmount: 3 }])
  })

  it('counts only capture gaps, and none when there are none', () => {
    expect(countCaptureGaps([
      ev('system', { subtype: 'recording_paused' }),
      ev('terminal', { subtype: 'capture_gap', reason: 'queue-full', skipped_units: 1 }),
      ev('scanner', { subtype: 'http_response', reason: 'queue-full' })
    ])).toEqual([])
  })
})
