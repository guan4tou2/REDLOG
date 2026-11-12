// Was recording paused at a given moment? (Spec 071 FR-082, T015)
//
// The answer used to be "is it paused now" (eventBus) plus, for delayed output,
// "is it older than the last resume". Neither asks the question. "Now" let a
// spool written during a pause, with the app down, be replayed into the chain
// once the app came back recording; "older than the last resume" refused a
// command_end observed before the pause, forever.
//
// The question is answered from what the project records: its
// `system.recording_paused` / `recording_resumed` rows, which main writes on
// every toggle and on every open whose state differs from the record's
// (core/recording-state-marker.ts). Two things are added to them:
//   - the pause in effect in this process, which may not be in the record yet
//     (a pause carried over from another project, or one whose row failed);
//   - a pause the record leaves open — no resume after it — while this process
//     is recording ended, at the latest, when this database was opened: that is
//     a crash or quit while paused, and the open is the "reopen" that closes it.
//     The marker main writes moments later says the same.

import { getDB, dbOpenedAt } from './db/index'
import { eventBus } from './event-bus'

export type RecordingState = 'recording' | 'paused'

interface StateRow { subtype: string; timestamp: number }

const STATE_SUBTYPES = `('recording_paused', 'recording_resumed')`

function persisted(sql: string, ...args: number[]): StateRow | undefined {
  try {
    return getDB().prepare(sql).get(...args) as StateRow | undefined
  } catch {
    return undefined // no database open: nothing is recorded, so nothing is paused in it
  }
}

/** Was recording paused at any moment of [from, to]? A point is from = to. */
export function pausedBetween(from: number, to: number): boolean {
  // In this process.
  if (eventBus.paused) {
    if (to >= eventBus.pausedAt) return true
  } else if (eventBus.pausedAt > 0 && eventBus.resumedAt > eventBus.pausedAt) {
    if (from < eventBus.resumedAt && to >= eventBus.pausedAt) return true
  }
  // In the record: the state in force at `from`…
  const before = persisted(`SELECT subtype, timestamp FROM events
    WHERE agent_type = 'system' AND subtype IN ${STATE_SUBTYPES} AND timestamp <= ?
    ORDER BY timestamp DESC, rowid DESC LIMIT 1`, from)
  if (before?.subtype === 'recording_paused' && !closedByReopen(before.timestamp, from)) return true
  // …and any pause that began inside the span.
  if (to > from) {
    const began = persisted(`SELECT subtype, timestamp FROM events
      WHERE agent_type = 'system' AND subtype = 'recording_paused' AND timestamp > ? AND timestamp <= ?
      LIMIT 1`, from, to)
    if (began) return true
  }
  return false
}

export function recordingStateAt(t: number): RecordingState {
  return pausedBetween(t, t) ? 'paused' : 'recording'
}

/** A pause that began at `pausedAt` and that the record never resumed, judged
 *  at `t`: over if this process is recording, the database was opened after the
 *  pause began, and `t` is at or after that open. */
function closedByReopen(pausedAt: number, t: number): boolean {
  if (eventBus.paused) return false
  const opened = dbOpenedAt()
  if (opened <= pausedAt || t < opened) return false
  const resumed = persisted(`SELECT subtype, timestamp FROM events
    WHERE agent_type = 'system' AND subtype = 'recording_resumed' AND timestamp > ?
    LIMIT 1`, pausedAt)
  return resumed === undefined
}
