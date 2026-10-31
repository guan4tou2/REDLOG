/** What a pane's recording went through while it ran, kept so the tab can
 *  still say it after the shell exits (#290). Live badges show the current
 *  state; once the pane is gone only this history is left to tell a complete
 *  recording from one that failed or skipped part of the session. */
export interface CastHistory {
  everRecorded?: boolean
  everPaused?: boolean
  everUnrecorded?: boolean
  failed?: boolean
}

export function castHistory(prev: CastHistory, state: TerminalCastState): CastHistory {
  return {
    everRecorded: prev.everRecorded || state.recording,
    everPaused: prev.everPaused || state.paused,
    // Stopped recording for a reason other than a pause, after it had begun.
    everUnrecorded: prev.everUnrecorded || (prev.everRecorded === true && !state.recording && !state.paused),
    failed: prev.failed || state.recordingReason === 'recording-failed'
  }
}

export type EndedRecording = 'failed' | 'not-recorded' | 'partly-unrecorded' | 'partly-paused' | null

/** The one thing an ended pane's tab says about its recording; null when it
 *  recorded the whole session. A failure outranks the rest. */
export function endedRecording(history: CastHistory): EndedRecording {
  if (history.failed) return 'failed'
  if (!history.everRecorded) return 'not-recorded'
  if (history.everUnrecorded) return 'partly-unrecorded'
  if (history.everPaused) return 'partly-paused'
  return null
}
