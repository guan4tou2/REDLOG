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
// — from when the project was opened (`system.session_start`, and this
// database's own open), and from the markers of this session still waiting to
// be written.
//
// A stretch of time reads as one of:
//   - 'paused': [pause, resume) with both rows written in one session. The
//     moment of the pause is paused, the moment of the resume is not.
//   - 'pause-end-unknown': a pause whose end the record does not show, in a
//     session that is over — no resume before the project was opened again
//     (the reopen's resume marker closes it), or a second pause row with no
//     resume between the two. Recording may have resumed and the marker been
//     lost. Refused, but as a loss, not as an intentional pause.
//   - 'unknown': the same, in this session — a pause with no resume yet, a
//     pause followed by another pause, or a marker still being retried. The
//     drain runs only while recording, so the resume did happen; it has not
//     been written yet. Files the answer bears on wait.
//   - 'recording': anything else.

import { dbOpenedAt, getDB } from './db/index'
import { recordingStateRows } from './db/events'
import { noteDbError } from './capture-health'

export type RecordingState = 'recording' | 'paused' | 'pause-end-unknown' | 'unknown'

export interface PauseSpan { start: number; end: number; state: Exclude<RecordingState, 'recording'> }

export interface RecordedPauses {
  /** Disjoint, oldest first, each [start, end). */
  spans: PauseSpan[]
  /** From this moment on nothing is known yet; null when everything is. */
  unknownFrom: number | null
}

/** Markers of this session whose write failed and is being retried. */
const pending = new Map<object, { at: number; opened: number }>()

/** Note that the marker for a toggle at `at` is not written yet. Returns the
 *  call that says it is settled (written, or given up with its project). */
export function markerPending(at: number): () => void {
  const key = {}
  pending.set(key, { at, opened: dbOpenedAt() })
  return () => { pending.delete(key) }
}

function pendingFrom(): number | null {
  const opened = dbOpenedAt()
  let from: number | null = null
  for (const [key, entry] of pending) {
    if (entry.opened !== opened) { pending.delete(key); continue } // another database's
    if (from === null || entry.at < from) from = entry.at
  }
  return from
}

export interface PauseRecord {
  /** Pause and resume rows, oldest first (timestamp, then rowid). */
  markers: ReadonlyArray<{ subtype: string; timestamp: number }>
  /** When the project was opened, each time: `system.session_start` rows. */
  opens: readonly number[]
}

function readRecord(): PauseRecord {
  const opens = (getDB().prepare(`SELECT timestamp FROM events WHERE agent_type = 'system' AND subtype = 'session_start'`)
    .all() as Array<{ timestamp: number }>).map((r) => r.timestamp)
  return { markers: recordingStateRows(), opens }
}

/** The spans a record gives, for a database opened at `sessionOpenedAt`. */
function pausesFromRecord(record: PauseRecord, sessionOpenedAt: number, pendingSince: number | null = null): RecordedPauses {
  const opens = [...record.opens, sessionOpenedAt].sort((a, b) => a - b)
  const spans: PauseSpan[] = []
  let paused: number | null = null
  /** A pause of this session followed by another pause: unknown until the
   *  next resume. */
  let unknownSince: number | null = null
  for (const row of record.markers) {
    if (row.subtype === 'recording_paused') {
      if (paused === null) { paused = row.timestamp; continue }
      // A second pause with no resume between: the resume was lost.
      if (paused >= sessionOpenedAt) unknownSince ??= paused
      else if (row.timestamp > paused) spans.push({ start: paused, end: row.timestamp, state: 'pause-end-unknown' })
      paused = row.timestamp
    } else if (row.subtype === 'recording_resumed' && paused !== null) {
      const resumed = row.timestamp
      if (unknownSince !== null) {
        spans.push({ start: unknownSince, end: resumed, state: 'unknown' })
        unknownSince = null
      } else {
        // An open in between: what came before it is not known to be paused.
        const reopened = opens.filter((o) => o > paused! && o <= resumed).pop()
        if (reopened === undefined) spans.push({ start: paused, end: resumed, state: 'paused' })
        else {
          spans.push({ start: paused, end: reopened, state: 'pause-end-unknown' })
          if (reopened < resumed) spans.push({ start: reopened, end: resumed, state: 'paused' })
        }
      }
      paused = null
    }
  }
  let unknownFrom: number | null = unknownSince
  if (unknownFrom === null && paused !== null) {
    if (paused < sessionOpenedAt) spans.push({ start: paused, end: sessionOpenedAt, state: 'pause-end-unknown' })
    else unknownFrom = paused
  }
  if (pendingSince !== null && (unknownFrom === null || pendingSince < unknownFrom)) unknownFrom = pendingSince
  return { spans: spans.filter((s) => s.end > s.start), unknownFrom }
}

/** Read the project's pause record once. A record that cannot be read says
 *  nothing is known, and the failure is reported. */
export function recordedPauses(read: () => PauseRecord = readRecord, report: (source: string, error: unknown) => void = noteDbError): RecordedPauses {
  let record: PauseRecord
  try { record = read() } catch (error) {
    report('recording-state', error)
    return { spans: [], unknownFrom: Number.NEGATIVE_INFINITY }
  }
  return pausesFromRecord(record, dbOpenedAt(), pendingFrom())
}

/** The state the record gives for moment `t`. */
export function stateAt(pauses: RecordedPauses, t: number): RecordingState {
  const span = pauses.spans.find((s) => t >= s.start && t < s.end)
  if (span?.state === 'paused') return 'paused'
  if (pauses.unknownFrom !== null && t >= pauses.unknownFrom) return 'unknown'
  return span?.state ?? 'recording'
}

/** The state of a span that began anywhere in (from, to] — such a stretch was
 *  in it for part of its length — or null when none did. */
export function spanBeganIn(pauses: RecordedPauses, from: number, to: number): Exclude<RecordingState, 'recording'> | null {
  const began = (start: number): boolean => start > from && start <= to
  const states = pauses.spans.filter((s) => began(s.start)).map((s) => s.state)
  if (states.includes('paused')) return 'paused'
  if (states.includes('unknown') || (pauses.unknownFrom !== null && began(pauses.unknownFrom))) return 'unknown'
  return states.length ? 'pause-end-unknown' : null
}

/** The [start, end) intervals known to be paused, for judging a producer's
 *  queue gap against (core/queue-gap.ts). */
export function pausedIntervals(pauses: RecordedPauses): Array<[number, number]> {
  return pauses.spans.filter((s) => s.state === 'paused').map((s) => [s.start, s.end])
}

/** Does [from, to] reach into a stretch whose state is not known yet? */
export function reachesUnknown(pauses: RecordedPauses, from: number, to: number): boolean {
  if (pauses.unknownFrom !== null && to >= pauses.unknownFrom) return true
  return pauses.spans.some((s) => s.state === 'unknown' && from < s.end && to >= s.start)
}
