import { memo } from 'react'
import type { TimelineInterval, TimelineIntervalSet, TimelineTrack } from '../../lib/timelineIntervals'
import { TRACK_LINE_Y, OPEN_STUB_PX, type IntervalMark } from '../../lib/timelineIntervalLayout'
import { safeDisplay } from '../../lib/evidenceText'
import { formatDateTime, formatElapsedMs, useDisplayZone } from '../../lib/time'
import { useI18n } from '../../i18n'

// S2 is deliberately visual only. S3 adds hit targets and removes the same
// commands' dots from the event row.
function trackLabel(track: TimelineTrack, builtinLabel: (idPrefix: string) => string): string {
  if (track.builtin) return builtinLabel(track.terminalId.slice(0, 4))
  return safeDisplay(`${track.shell ?? ''} ${track.pid ?? track.terminalId.slice(-6)}`.trim())
}

export interface TimelineCommandTracksProps {
  set: TimelineIntervalSet
  marks: readonly IntervalMark[]
  order: readonly string[]
  laneH: number
  trackW: number
  scrollLeft: number
  rows: { first: number; last: number }
  builtinLabel: (idPrefix: string) => string
}

type Translate = ReturnType<typeof useI18n>['t']
function intervalTitle(iv: TimelineInterval, label: string, t: Translate): string {
  const start = iv.startTs === null ? t('timeline.command.startUnloaded') : formatDateTime(iv.startTs, { seconds: true })
  const end = iv.endTs === null ? t('timeline.command.unfinished') : formatDateTime(iv.endTs, { seconds: true })
  const duration = iv.startTs !== null && iv.endTs !== null ? formatElapsedMs(iv.endTs - iv.startTs)
    : iv.startTs === null && iv.reportedDurationSec !== null
      ? t('timeline.command.reportedDuration', { duration: formatElapsedMs(iv.reportedDurationSec * 1000) }) : ''
  const state = iv.endBasis === 'open' ? t('timeline.command.unfinished')
    : iv.endBasis === 'superseded' ? t('eventTitle.commandInterrupted')
      : iv.exitCode === null ? t('activity.result.ended') : t('transcript.metaExit', { code: iv.exitCode })
  return [`${start}–${end}`, label, safeDisplay(iv.command), duration, state,
    iv.reversed ? t('timeline.command.reversed') : ''].filter(Boolean).join(' · ')
}

function EndShape({ mark, x, y }: { mark: IntervalMark; x: number; y: number }): JSX.Element | null {
  if (mark.endCap === 'open' || mark.endCap === 'open-stub') return null
  if (mark.endCap === 'failed') return (
    <svg data-end-shape="cross" className="absolute text-redlog-text" style={{ left: x - 4, top: y - 4, width: 8, height: 8 }} viewBox="0 0 8 8">
      <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
  const hollow = mark.endCap === 'no-result'
  const circle = hollow && mark.kind === 'point'
  return <span
    data-end-shape={circle ? 'hollow-circle' : hollow ? 'hollow-bar' : 'filled-bar'}
    className={`absolute border-2 border-redlog-text ${hollow ? 'bg-redlog-bg' : 'bg-redlog-text'} ${circle ? 'rounded-full' : ''}`}
    style={{ left: x - (circle ? 4 : 2), top: y - 4, width: circle ? 8 : 4, height: 8 }}
  />
}

/** First other mark to the right, for FR-022's optional exit code. */
function freeAfter(positions: readonly number[], x: number, trackW: number): number {
  let lo = 0, hi = positions.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (positions[mid] <= x) lo = mid + 1; else hi = mid
  }
  return Math.min(trackW, positions[lo] ?? trackW) - x - 8
}

export const TimelineCommandTracks = memo(function TimelineCommandTracks({
  set, marks, order, laneH, trackW, scrollLeft, rows, builtinLabel
}: TimelineCommandTracksProps): JSX.Element | null {
  const { t } = useI18n()
  useDisplayZone()
  if (order.length === 0) return null
  const tracks = new Map(set.tracks.map((track) => [track.key, track]))
  const byRow = new Map<number, IntervalMark[]>()
  for (const mark of marks) {
    const own = byRow.get(mark.row)
    if (own) own.push(mark); else byRow.set(mark.row, [mark])
  }
  return (
    <div data-testid="timeline-command-tracks" aria-hidden="true" className="absolute inset-0 pointer-events-none">
      {order.map((key, i) => {
        const row = i + 1
        if (row < rows.first - 1 || row > rows.last + 1) return null
        const track = tracks.get(key)
        if (!track) return null
        const label = trackLabel(track, builtinLabel)
        const own = byRow.get(row) ?? []
        const positions = own.flatMap((m) => [m.x0, m.x1]).sort((a, b) => a - b)
        return (
          <div key={key} data-testid="timeline-command-track" data-track-key={key}
            className="absolute left-0 w-full" style={{ top: row * laneH, height: laneH }}>
            {own.map((mark) => {
              const iv = mark.intervals[0]
              const point = mark.kind === 'point'
              const cluster = mark.kind === 'cluster'
              const endX = point ? mark.x0 + 10 : mark.x1
              const dashed = mark.open > 0 || mark.startCap === 'unloaded'
              const lineEnd = point && mark.open > 0 ? mark.x0 + OPEN_STUB_PX : mark.x1
              const title = mark.intervals.map((member) => intervalTitle(member, label, t)).join('\n')
              const name = safeDisplay(iv.command.replace(/\s+/g, ' ').trim())
              return (
                <div key={mark.key} data-testid="timeline-interval-mark" data-mark-kind={mark.kind} title={title}>
                  {lineEnd > mark.x0 && (
                    <div data-testid="timeline-interval-line" data-interval-id={mark.key} data-line={dashed ? 'dashed' : 'solid'}
                      className={`absolute border-t-2 border-redlog-text-dim ${dashed ? 'border-dashed' : ''}`}
                      style={{ left: mark.x0, width: lineEnd - mark.x0, top: TRACK_LINE_Y - 1 }} />
                  )}
                  {cluster ? (
                    <span data-testid="timeline-interval-count"
                      className={`absolute border bg-redlog-bg text-redlog-text font-mono text-xs leading-none rounded-full ${mark.open > 0 ? 'border-dashed' : ''}`}
                      style={{ left: mark.x0 - 8, top: TRACK_LINE_Y - 8, minWidth: 16, height: 16, textAlign: 'center' }}>
                      {mark.intervals.length}
                    </span>
                  ) : mark.startCap === 'mark' ? (
                    <span data-testid="timeline-start-mark" className="absolute rounded-full bg-redlog-text"
                      style={{ left: mark.x0 - 4, top: TRACK_LINE_Y - 4, width: 8, height: 8 }} />
                  ) : null}
                  {(!cluster || mark.failed > 0) && <EndShape mark={mark} x={cluster ? mark.x0 + 13 : endX} y={TRACK_LINE_Y} />}
                  {!cluster && mark.endCap === 'failed' && freeAfter(positions, endX, trackW) >= 20 && (
                    <span data-testid="timeline-exit-code" className="absolute font-mono text-xs leading-none text-redlog-text"
                      style={{ left: endX + 8, top: TRACK_LINE_Y - 5 }}>{iv.exitCode}</span>
                  )}
                  {mark.label && (
                    <span data-testid="timeline-interval-name" title={title} className="absolute block truncate whitespace-nowrap font-mono text-xs leading-none text-redlog-text"
                      style={{ left: mark.label.side === 'right' ? mark.x0 + 6 : mark.x0 - 6 - mark.label.maxW,
                        width: mark.label.maxW, maxWidth: mark.label.maxW, textAlign: mark.label.side === 'left' ? 'right' : 'left', top: TRACK_LINE_Y - 16 }}>
                      {name}
                    </span>
                  )}
                </div>
              )
            })}
            <span data-testid="timeline-track-label" className="absolute whitespace-nowrap font-mono text-xs leading-none text-redlog-text-faint"
              style={{ left: scrollLeft + 4, top: 0 }}>{label}</span>
          </div>
        )
      })}
    </div>
  )
})
