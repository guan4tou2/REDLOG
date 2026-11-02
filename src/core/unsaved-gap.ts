// The managed proxy's addon records every capture gap in the spool. When it
// cannot (#460, #507) its log is all there is, and it says so in one form for
// every gap, whatever the reason:
//
//   [redlog] capture gap not saved: 7 event(s) reason=proxy-stopped started=1700000000000 ended=1700000002000 engagement=<id> nonce=<hex>
//
// `started`/`ended` are the window the gap covers and `engagement` is the
// project that owns it. None of it carries a URL, header or body.
//
// The proxy's output is not only the addon's: mitmproxy echoes what a remote
// server sent it, such as an unparseable status line, so a line shaped like
// this one can be written by whoever the user browses to. The `nonce` is the
// proof the addon wrote it: the app makes one per proxy start, hands it to the
// addon in its environment and accepts no line without it. The pattern is also
// anchored to the whole line and every field is bounded.

export interface UnsavedGap {
  units: number
  reason: string
  startedAt: number
  endedAt: number
  engagementId: string
}

/** Every reason the addon writes a gap for. */
const REASONS = 'queue-full|project-switched|proxy-stopped|delivery-unconfirmed|delivery-interrupted'

const GAP_LINE = new RegExp(
  `^(?:\\[\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?\\] )?\\[redlog\\] capture gap not saved: (\\d{1,9}) event\\(s\\) reason=(${REASONS})`
  + ' started=(\\d{1,16}) ended=(\\d{1,16}) engagement=(\\S{1,128}) nonce=(\\S{1,128})$'
)

/** A window flushes every second and the queue and spool are bounded, so no
 *  real gap counts anything like this; a larger number is not the addon's. */
const MAX_UNITS = 1_000_000

/** The gap one line of the addon's output reports, or null for any other line,
 *  including one that does not carry `nonce`. */
export function parseUnsavedGapLine(line: string, nonce: string): UnsavedGap | null {
  const match = GAP_LINE.exec(line)
  if (!match || !nonce || match[6] !== nonce) return null
  const units = Number(match[1])
  if (!(units > 0 && units <= MAX_UNITS)) return null
  return { units, reason: match[2], startedAt: Number(match[3]), endedAt: Number(match[4]), engagementId: match[5] }
}

/** A delivery that was not confirmed may have arrived: unknown, not loss. */
const UNKNOWN_DELIVERY = new Set(['delivery-unconfirmed', 'delivery-interrupted'])

/** The Timeline event for a gap the addon could not save, so an export carries
 *  it. `reason` stays `gap-unsaved`; what the gap was is `gap_reason`. */
function unsavedGapEventData(gap: UnsavedGap): Record<string, unknown> {
  return {
    subtype: 'capture_gap', source: 'managed-http-proxy', reason: 'gap-unsaved', gap_reason: gap.reason,
    skipped_units: gap.units,
    ...(UNKNOWN_DELIVERY.has(gap.reason) ? { capture_delivery: 'unknown' } : {}),
    gap_started_at: gap.startedAt, gap_ended_at: gap.endedAt,
    description: `${gap.units} HTTP event(s) not recorded (${gap.reason}); the addon could not save the gap record`
  }
}

/** The event to record for `gap` in the project open now, or null when the gap
 *  is not that project's. A line is trusted for its count and window, never
 *  for where to put them: only the project it names may be given it. */
export function unsavedGapForProject(gap: UnsavedGap, open: { engagementId: string } | null): Record<string, unknown> | null {
  return open && gap.engagementId === open.engagementId ? unsavedGapEventData(gap) : null
}
