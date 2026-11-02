// The managed proxy's addon records every capture gap in the spool. When it
// cannot (#460, #507) its log is all there is, and it says so in one form for
// every gap, whatever the reason:
//
//   [redlog] capture gap not saved: 7 event(s) reason=proxy-stopped started=1700000000000 ended=1700000002000 engagement=<id>
//
// `started`/`ended` are the window the gap covers and `engagement` is the
// project that owns it. Neither carries a URL, header or body.

export interface UnsavedGap {
  units: number
  reason: string
  startedAt?: number
  endedAt?: number
  engagementId?: string
}

const GAP_LINE = /\[redlog\] capture gap not saved: (\d+) event\(s\) reason=(\S+)/
const WINDOW = /\bstarted=(\d+) ended=(\d+)/
const OWNER = / engagement=(.+?)\s*$/

/** The gap one line of the addon's output reports, or null for any other line. */
export function parseUnsavedGapLine(line: string): UnsavedGap | null {
  const head = GAP_LINE.exec(line)
  if (!head) return null
  const units = Number(head[1])
  if (!(units > 0)) return null
  const gap: UnsavedGap = { units, reason: head[2] }
  const window = WINDOW.exec(line)
  if (window) { gap.startedAt = Number(window[1]); gap.endedAt = Number(window[2]) }
  const owner = OWNER.exec(line)
  if (owner) gap.engagementId = owner[1]
  return gap
}

/** A delivery that was not confirmed may have arrived: unknown, not loss. */
const UNKNOWN_DELIVERY = new Set(['delivery-unconfirmed', 'delivery-interrupted'])

/** The Timeline event for a gap the addon could not save, so an export carries
 *  it. `reason` stays `gap-unsaved`; what the gap was is `gap_reason`. */
export function unsavedGapEventData(gap: UnsavedGap): Record<string, unknown> {
  return {
    subtype: 'capture_gap', source: 'managed-http-proxy', reason: 'gap-unsaved', gap_reason: gap.reason,
    skipped_units: gap.units,
    ...(UNKNOWN_DELIVERY.has(gap.reason) ? { capture_delivery: 'unknown' } : {}),
    ...(gap.startedAt !== undefined ? { gap_started_at: gap.startedAt, gap_ended_at: gap.endedAt ?? gap.startedAt } : {}),
    description: `${gap.units} HTTP event(s) not recorded (${gap.reason}); the addon could not save the gap record`
  }
}
