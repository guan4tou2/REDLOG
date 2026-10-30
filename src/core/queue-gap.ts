// A queue-full capture gap counts events the proxy addon refused (#460). It is
// spooled and replayed later, and the replay knows nothing about when
// recording was paused: a gap counted while paused read as a loss in a stretch
// nothing was meant to be recorded. These two functions judge it against the
// pause intervals the Timeline already holds.

export type PauseInterval = [start: number, end: number]

/** `recording_paused` / `recording_resumed` rows, oldest first, as intervals.
 *  A pause with no resume after it is still open. */
export function pauseIntervals(rows: ReadonlyArray<{ subtype: string; timestamp: number }>): PauseInterval[] {
  const intervals: PauseInterval[] = []
  let openedAt: number | null = null
  for (const row of rows) {
    if (row.subtype === 'recording_paused' && openedAt === null) openedAt = row.timestamp
    else if (row.subtype === 'recording_resumed' && openedAt !== null) {
      intervals.push([openedAt, row.timestamp])
      openedAt = null
    }
  }
  if (openedAt !== null) intervals.push([openedAt, Infinity])
  return intervals
}

/** Null when every refusal fell inside one pause: nothing was being recorded,
 *  so nothing was lost. A window that crosses a pause boundary is kept — some
 *  of it was a real loss and the count cannot be split — and says so. Any
 *  other gap is returned as it came. */
export function queueGapAgainstPauses<T extends Record<string, unknown>>(data: T, pauses: readonly PauseInterval[]): (T & { overlaps_pause?: true }) | null {
  if (data.subtype !== 'capture_gap' || data.reason !== 'queue-full') return data
  const start = Number(data.gap_started_at)
  const end = Number(data.gap_ended_at ?? data.gap_started_at)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return data
  if (pauses.some(([from, to]) => from <= start && end <= to)) return null
  if (pauses.some(([from, to]) => from <= end && start <= to)) return { ...data, overlaps_pause: true }
  return data
}
