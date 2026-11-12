// What this project RECORDED about pauses (Spec 071 FR-082 as revised
// 2026-11-13, T015).
//
// Used by one door only: the hook-spool drain, which runs only while
// recording, and asks this of a file's source time once the pause it may have
// been observed in is over. Live doors do not ask it: they are judged by
// whether recording is paused when the item arrives (core/ingest.ts), because
// a producer's time is a claim, not a fact.
//
// The answer comes from the project's `system.recording_paused` /
// `recording_resumed` rows — which main writes on every toggle and on every
// open whose state differs from the record's (core/recording-state-marker.ts)
// — and from when this database was opened. Nothing in memory.
//
// An interval is [pause, resume): the moment of the pause is paused, the
// moment of the resume is not. A pause the record leaves open — no resume
// after it —
//   - began before this database was opened: it ended, at the latest, when it
//     was opened (a crash or quit while paused; the reopen marker main writes
//     moments later says the same);
//   - began after: its end is UNKNOWN. The drain runs only while recording, so
//     it did end, but the resume row was not written (yet). A time after such
//     a pause began is neither "paused" nor "recording": the drain leaves the
//     file for later rather than drop what may have been recorded.

import { dbOpenedAt } from './db/index'
import { recordingStateRows } from './db/events'
import { pauseIntervals } from './queue-gap'

export type RecordingState = 'recording' | 'paused' | 'unknown'

export interface RecordedPauses {
  /** Closed intervals, [start, end), oldest first. */
  intervals: Array<[number, number]>
  /** The start of a pause with no recorded end, begun in this session; null
   *  when there is none. */
  unresolvedFrom: number | null
}

/** Read the project's pause record once. */
export function recordedPauses(): RecordedPauses {
  let rows: Array<{ subtype: string; timestamp: number }> = []
  try { rows = recordingStateRows() } catch { /* no database open: nothing is recorded in it */ }
  // The queue-gap reader's intervals, with its open end (Infinity) resolved.
  const intervals = pauseIntervals(rows)
  const last = intervals[intervals.length - 1]
  if (!last || last[1] !== Infinity) return { intervals, unresolvedFrom: null }
  const openedAt = last[0]
  const reopened = dbOpenedAt()
  if (reopened > openedAt) {
    last[1] = reopened
    return { intervals, unresolvedFrom: null }
  }
  intervals.pop()
  return { intervals, unresolvedFrom: openedAt }
}

/** The state the record gives for moment `t`. */
export function stateAt(pauses: RecordedPauses, t: number): RecordingState {
  if (pauses.intervals.some(([start, end]) => t >= start && t < end)) return 'paused'
  if (pauses.unresolvedFrom !== null && t >= pauses.unresolvedFrom) return 'unknown'
  return 'recording'
}

/** Did a recorded pause begin anywhere in (from, to]? Such a span was paused
 *  for part of its length, whenever that pause ended. */
export function pauseBeganIn(pauses: RecordedPauses, from: number, to: number): boolean {
  const began = (start: number): boolean => start > from && start <= to
  return pauses.intervals.some(([start]) => began(start)) || (pauses.unresolvedFrom !== null && began(pauses.unresolvedFrom))
}
