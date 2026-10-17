// Pause is a flag in memory. It is not stored with the project, so it does not
// survive a restart, and it is not scoped to a project, so it survives opening
// another one. Either way the record of the project being opened has to explain
// itself: the timeline draws a pause as a band from `recording_paused` to the
// next `recording_resumed`, and a reader of a handed-over record cannot see the
// app's memory.

export interface RecordingMarker {
  subtype: 'recording_paused' | 'recording_resumed'
  source: string
  description: string
}

/** The marker a project needs when it is opened, or null when its record
 *  already says the right thing.
 *
 *  - paused now: this project starts without recording, so its chain gets the
 *    pause (a pause begun in another project, or before a restart, is not in
 *    this chain).
 *  - recording now, but this project's last word was "paused": that pause did
 *    not carry over (restart), and without a resume the timeline would draw it
 *    open until now across events that were recorded. */
export function markerForOpen(pausedNow: boolean, lastSubtype: string | null): RecordingMarker | null {
  if (pausedNow) {
    if (lastSubtype === 'recording_paused') return null
    return {
      subtype: 'recording_paused',
      source: 'carried-over',
      description: 'Recording is paused: the pause was set before this project was opened and is still in effect'
    }
  }
  if (lastSubtype === 'recording_paused') {
    return {
      subtype: 'recording_resumed',
      source: 'project-open',
      description: 'Recording resumed: the app restarted or the project was reopened, and the earlier pause did not carry over'
    }
  }
  return null
}
