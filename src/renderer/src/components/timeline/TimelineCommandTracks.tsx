import { memo } from 'react'
import type { TimelineInterval, TimelineIntervalSet, TimelineTrack } from '../../lib/timelineIntervals'
import { safeDisplay } from '../../lib/evidenceText'

// Spec 078 S1: the standard mode's terminal rows, drawn over the track below
// the event row. In this slice a row is its label and one line per command;
// end marks, names and clusters come with S2, and nothing here is clickable or
// announced until S3, so the layer is aria-hidden and ignores the pointer.
// Every command is still a dot on the event row meanwhile (the S1 transitional
// state the spec describes).

/** The line's centre in its row; the label sits above it. */
const LINE_Y = 28
/** FR-006: an end whose start is not loaded gets this much, never a line from
 *  the loaded edge. */
const UNLOADED_STUB_PX = 16
const LABEL_INSET_PX = 4

interface Line { id: string; x0: number; x1: number; dashed: boolean }

/** One terminal's lines, in start order. A reversed interval (its end stamped
 *  before its start) gets none rather than a negative width (FR-008); an open
 *  one is dashed to the next start on the same terminal, or to the right edge
 *  when it is the last (FR-024, owner Q4). Clipped to the track: the left clip
 *  is transitional until S3 widens the time range to interval starts. */
function trackLines(own: readonly TimelineInterval[], toX: (ts: number) => number, trackW: number): Line[] {
  const out: Line[] = []
  own.forEach((iv, i) => {
    if (iv.reversed) return
    let x0: number
    let x1: number
    let dashed = false
    if (iv.startTs === null) {
      if (iv.endTs === null) return
      x1 = toX(iv.endTs)
      x0 = x1 - UNLOADED_STUB_PX
      dashed = true
    } else if (iv.endBasis === 'open') {
      const startTs = iv.startTs
      const next = own.slice(i + 1).find((o) => o.startTs !== null && o.startTs > startTs)
      x0 = toX(startTs)
      x1 = next?.startTs != null ? toX(next.startTs) : trackW
      dashed = true
    } else {
      if (iv.endTs === null) return
      x0 = toX(iv.startTs)
      x1 = toX(iv.endTs)
    }
    x0 = Math.max(0, x0)
    x1 = Math.min(trackW, x1)
    if (x1 > x0) out.push({ id: iv.id, x0, x1, dashed })
  })
  return out
}

/** Q2: `{shell} {pid}`; the built-in terminal keeps the session band's
 *  「終端 ab12」. No tty: the rows do not carry one. */
function trackLabel(track: TimelineTrack, builtinLabel: (idPrefix: string) => string): string {
  if (track.builtin) return builtinLabel(track.terminalId.slice(0, 4))
  return safeDisplay(`${track.shell ?? ''} ${track.pid ?? track.terminalId.slice(-6)}`.trim())
}

export interface TimelineCommandTracksProps {
  set: TimelineIntervalSet
  /** The terminal rows' track keys, top to bottom. */
  order: readonly string[]
  /** The row index of `order[0]`. */
  firstRow: number
  laneH: number
  trackW: number
  toX: (ts: number) => number
  /** Horizontal scroll offset in track px: Q3's label stays at the visible
   *  left edge by being placed there, not by `position: sticky`, whose
   *  behaviour inside these absolutely placed rows under `body { zoom }` no
   *  test here can see. */
  scrollLeft: number
  builtinLabel: (idPrefix: string) => string
}

export const TimelineCommandTracks = memo(function TimelineCommandTracks({
  set, order, firstRow, laneH, trackW, toX, scrollLeft, builtinLabel
}: TimelineCommandTracksProps): JSX.Element | null {
  if (order.length === 0) return null
  const byTrack = new Map<string, TimelineInterval[]>()
  for (const iv of set.intervals) {
    const list = byTrack.get(iv.trackKey)
    if (list) list.push(iv); else byTrack.set(iv.trackKey, [iv])
  }
  const tracks = new Map(set.tracks.map((t) => [t.key, t]))
  return (
    <div data-testid="timeline-command-tracks" aria-hidden="true" className="absolute inset-0 pointer-events-none">
      {order.map((key, i) => {
        const track = tracks.get(key)
        if (!track) return null
        return (
          <div
            key={key}
            data-testid="timeline-command-track"
            data-track-key={key}
            className="absolute left-0 w-full"
            style={{ top: (firstRow + i) * laneH, height: laneH }}
          >
            {trackLines(byTrack.get(key) ?? [], toX, trackW).map((l) => (
              <div
                key={l.id}
                data-testid="timeline-interval-line"
                data-interval-id={l.id}
                data-line={l.dashed ? 'dashed' : 'solid'}
                className={`absolute border-t-2 border-redlog-text-dim ${l.dashed ? 'border-dashed' : ''}`}
                style={{ left: l.x0, width: l.x1 - l.x0, top: LINE_Y - 1 }}
              />
            ))}
            <span
              data-testid="timeline-track-label"
              className="absolute whitespace-nowrap font-mono text-xs leading-none text-redlog-text-faint"
              style={{ left: scrollLeft + LABEL_INSET_PX, top: 4 }}
            >{trackLabel(track, builtinLabel)}</span>
          </div>
        )
      })}
    </div>
  )
})
