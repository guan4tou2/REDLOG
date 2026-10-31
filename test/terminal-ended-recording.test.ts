import { describe, expect, it } from 'vitest'
import { castHistory, endedRecording } from '../src/renderer/src/lib/terminalRecordingSummary'

// #290: once a pane's shell exits, its tab lost every recording badge and kept
// only "[process exited]", so a recording that failed or was paused for part
// of the session read the same as a complete one. The tab now keeps what the
// recording went through, as it went.

const run = (...states: Array<{ recording: boolean; paused: boolean; recordingReason?: 'no-project' | 'recording-failed' }>) =>
  states.reduce((history, state) => castHistory(history, { castTruncated: false, ...state }), {})

describe('what an ended pane says about its recording', () => {
  it('says nothing more for a recording that ran start to finish', () => {
    expect(endedRecording(run({ recording: true, paused: false }))).toBeNull()
  })

  it('keeps a pause that happened at any point, even after resuming', () => {
    expect(endedRecording(run({ recording: true, paused: false }, { recording: false, paused: true }, { recording: true, paused: false }))).toBe('partly-paused')
  })

  it('keeps a failure, which outranks a pause', () => {
    expect(endedRecording(run({ recording: true, paused: false }, { recording: false, paused: true }, { recording: false, paused: false, recordingReason: 'recording-failed' }))).toBe('failed')
  })

  it('says a pane that never recorded was not recorded', () => {
    expect(endedRecording(run({ recording: false, paused: false, recordingReason: 'no-project' }))).toBe('not-recorded')
    expect(endedRecording({})).toBe('not-recorded')
  })

  it('counts a pane that recorded before its project closed as partly recorded', () => {
    expect(endedRecording(run({ recording: true, paused: false }, { recording: false, paused: false, recordingReason: 'no-project' }))).toBe('partly-unrecorded')
  })
})
