// Did this project RECORD a pause at a given moment? (Spec 071 FR-082 as
// revised 2026-11-13, T015)
//
// Used by one door only: the hook-spool drain, which runs only while
// recording, and asks this of a file's source time once the pause it may have
// been observed in is over. Live doors do not ask it: they are judged by
// whether recording is paused when the item arrives (core/ingest.ts), because
// a producer's time is a claim, not a fact.
//
// The answer comes from the project's `system.recording_paused` /
// `recording_resumed` rows, which main writes on every toggle and on every
// open whose state differs from the record's (core/recording-state-marker.ts),
// and from nothing in memory. One addition: a pause the record leaves open —
// no resume after it — ended, at the latest, when this database was opened.
// That is a crash or a quit while paused; the reopen marker main writes moments
// after the open says the same.

import { getDB, dbOpenedAt } from './db/index'

export type RecordingState = 'recording' | 'paused'

interface StateRow { subtype: string; timestamp: number }

function recorded(sql: string, ...args: number[]): StateRow | undefined {
  try {
    return getDB().prepare(sql).get(...args) as StateRow | undefined
  } catch {
    return undefined // no database open: nothing is recorded in it
  }
}

/** The state the project's record gives for moment `t`. */
export function recordingStateAt(t: number): RecordingState {
  const before = recorded(`SELECT subtype, timestamp FROM events
    WHERE agent_type = 'system' AND subtype IN ('recording_paused', 'recording_resumed') AND timestamp <= ?
    ORDER BY timestamp DESC, rowid DESC LIMIT 1`, t)
  if (before?.subtype !== 'recording_paused') return 'recording'
  return closedByReopen(before.timestamp, t) ? 'recording' : 'paused'
}

/** Did a recorded pause begin anywhere in (from, to]? */
export function pauseBeganBetween(from: number, to: number): boolean {
  return to > from && recorded(`SELECT subtype, timestamp FROM events
    WHERE agent_type = 'system' AND subtype = 'recording_paused' AND timestamp > ? AND timestamp <= ?
    LIMIT 1`, from, to) !== undefined
}

/** A pause that began at `pausedAt` and that the record never resumed, judged
 *  at `t`: over if the database was opened after it began and `t` is at or
 *  after that open. */
function closedByReopen(pausedAt: number, t: number): boolean {
  const opened = dbOpenedAt()
  if (opened <= pausedAt || t < opened) return false
  return recorded(`SELECT subtype, timestamp FROM events
    WHERE agent_type = 'system' AND subtype = 'recording_resumed' AND timestamp > ?
    LIMIT 1`, pausedAt) === undefined
}
