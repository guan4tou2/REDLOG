// Pause is a flag in memory. It is not stored with the project, so it does not
// survive a restart, and it is not scoped to a project, so it survives opening
// another one. Either way the record of the project being opened has to explain
// itself: the timeline draws a pause as a band from `recording_paused` to the
// next `recording_resumed`, and a reader of a handed-over record cannot see the
// app's memory.

import { markerPending, markerLanded, persistedMarkers, lastRecordingMarker, type PersistedMarker } from './recording-state'

export interface RecordingMarker {
  subtype: 'recording_paused' | 'recording_resumed'
  source: string
  description: string
}

/** How long to wait before each retry of a marker that failed to write; the
 *  last delay repeats for as long as the project is open. */
export const MARKER_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000]

/** Write a pause/resume marker, and keep trying while it throws.
 *
 *  These rows are the whole record of a pause, and the spool drain reads them
 *  (core/recording-state.ts). A failure is reported where capture-write
 *  failures are (`onError`) and retried at the marker's own time, so the row
 *  lands where the toggle happened. Until it lands the drain treats every time
 *  from `at` on as unknown and holds those files back (`markerPending`). Only a
 *  throw is retried: a write that returns, with a row or without one (refused
 *  for good), ends it, as does `isCurrent` turning false. */
export function writeMarkerWithRetry(options: {
  /** When the toggle happened. */
  at: number
  /** The marker, kept beside the project database while its write fails, and
   *  written at the project's next open if it never lands in this one. */
  record?: PersistedMarker
  /** `retry` is true from the second try on: the row then needs the toggle's
   *  own time, which the first try gets by being written at it. */
  write: (retry: boolean) => void
  onError: (error: unknown) => void
  schedule: (retry: () => void, ms: number) => void
  isCurrent: () => boolean
}): void {
  let attempt = 0
  let settle: (() => void) | null = null
  const run = (): void => {
    if (!options.isCurrent()) { settle?.(); return }
    try {
      options.write(attempt > 0)
      settle?.()
      if (options.record) markerLanded(options.record)
      return
    } catch (error) {
      options.onError(error)
    }
    settle ??= markerPending(options.at, options.record)
    const delay = MARKER_RETRY_DELAYS_MS[Math.min(attempt, MARKER_RETRY_DELAYS_MS.length - 1)]
    attempt++
    options.schedule(run, delay)
  }
  run()
}

/** At open, before the drain can run and before `markerForOpen`: write each
 *  marker an earlier open could not, at its own time (`write` gets the marker
 *  and must write it at `marker.at`), through the same retry. */
export function writePersistedMarkers(options: {
  write: (marker: PersistedMarker) => void
  onError: (error: unknown) => void
  schedule: (retry: () => void, ms: number) => void
  isCurrent: () => boolean
}): void {
  for (const marker of persistedMarkers()) {
    writeMarkerWithRetry({ ...options, at: marker.at, record: marker, write: () => options.write(marker) })
  }
}

/** What opening a project writes about recording, in this order (Spec 071
 *  FR-082): `session_start`; the markers an earlier open could not write, each
 *  at its own time; then the marker the open itself needs, decided from the
 *  last marker anyone knows of — the chain's, or one still waiting
 *  (`lastRecordingMarker`). Main calls this before the drain can run. */
export function recordProjectOpen(options: {
  sessionStart: () => void
  /** Write a marker row; `occurredAt` for one that lands after its toggle. */
  write: (data: Record<string, unknown>, occurredAt?: number) => void
  paused: boolean
  onError: (error: unknown) => void
  schedule: (retry: () => void, ms: number) => void
  isCurrent: () => boolean
}): void {
  const { sessionStart, write, paused, ...retry } = options
  sessionStart()
  writePersistedMarkers({ ...retry, write: (marker) => write(marker.data, marker.at) })
  let marker: RecordingMarker | null = null
  try { marker = markerForOpen(paused, lastRecordingMarker()) } catch (error) { retry.onError(error) }
  if (!marker) return
  const at = Date.now()
  const record: PersistedMarker = { subtype: marker.subtype, at, data: { subtype: marker.subtype, description: marker.description, source: marker.source } }
  writeMarkerWithRetry({ ...retry, at, record, write: (again) => write(record.data, again ? at : undefined) })
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
