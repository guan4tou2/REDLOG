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

import fs from 'fs'
import path from 'path'
import { dbGeneration, dbOpenedAt, getDB, getProjectDir } from './db/index'
import { writePrivateFileAtomic } from './private-fs'
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

/** A marker as main writes it, kept beside the project database while its
 *  write keeps failing, so a quit does not lose it (Spec 071 FR-082). */
export interface PersistedMarker {
  subtype: 'recording_paused' | 'recording_resumed'
  at: number
  data: Record<string, unknown>
}

const PENDING_FILE = 'recording-markers-pending.json'

function pendingFile(): string | null {
  try { return path.join(getProjectDir(), PENDING_FILE) } catch { return null }
}

function readPersisted(file: string): PersistedMarker[] {
  let parsed: unknown
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((m): m is PersistedMarker =>
    !!m && (m.subtype === 'recording_paused' || m.subtype === 'recording_resumed') &&
    typeof m.at === 'number' && Number.isFinite(m.at) && !!m.data && typeof m.data === 'object')
}

function writePersisted(file: string, markers: PersistedMarker[]): void {
  if (markers.length === 0) { try { fs.unlinkSync(file) } catch { /* none */ } return }
  writePrivateFileAtomic(file, JSON.stringify(markers))
}

const sameMarker = (a: PersistedMarker, b: PersistedMarker): boolean => a.subtype === b.subtype && a.at === b.at

/** Note that the marker for a toggle at `at` is not written yet; with
 *  `record`, keep it on disk too. Returns the call that takes it off the
 *  in-memory list (written, or given up with its project — the disk copy then
 *  waits for the project's next open). */
export function markerPending(at: number, record?: PersistedMarker): () => void {
  const key = {}
  pending.set(key, { at, opened: dbGeneration() })
  const file = record ? pendingFile() : null
  if (record && file) {
    try {
      const kept = readPersisted(file)
      if (!kept.some((m) => sameMarker(m, record))) writePersisted(file, [...kept, record])
    } catch (error) { noteDbError('recording-marker', error) }
  }
  return () => { pending.delete(key) }
}

/** The marker is in the chain: forget its disk copy. */
export function markerLanded(record: PersistedMarker): void {
  const file = pendingFile()
  if (!file) return
  try {
    const kept = readPersisted(file)
    const rest = kept.filter((m) => !sameMarker(m, record))
    if (rest.length !== kept.length) writePersisted(file, rest)
  } catch (error) { noteDbError('recording-marker', error) }
}

/** Markers an earlier open could not write, oldest first. Main writes each at
 *  its own time when the project opens, before the drain can run. */
export function persistedMarkers(): PersistedMarker[] {
  const file = pendingFile()
  return file ? readPersisted(file).sort((a, b) => a.at - b.at) : []
}

function pendingFrom(): number | null {
  const opened = dbGeneration() // the database this is, not when it opened: two can open in one ms
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
      // A second pause with no resume between: the resume was lost. What lies
      // in an ended open is a loss; from this open's start on, it waits.
      if (paused >= sessionOpenedAt) unknownSince ??= paused
      else if (row.timestamp >= sessionOpenedAt) {
        spans.push({ start: paused, end: sessionOpenedAt, state: 'pause-end-unknown' })
        unknownSince ??= sessionOpenedAt
      } else if (row.timestamp > paused) spans.push({ start: paused, end: row.timestamp, state: 'pause-end-unknown' })
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
