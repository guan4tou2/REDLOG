import { memo, type RefObject } from 'react'
import type { TimelineInterval, TimelineIntervalSet, TimelineTrack } from '../../lib/timelineIntervals'
import { TRACK_LINE_Y, OPEN_STUB_PX, type IntervalMark } from '../../lib/timelineIntervalLayout'
import type { RedLogEvent } from '../../../../core/db/event-types'
import { ioMark, ioTitle, IO_MARK_COLOR, type EventBadge } from '../../lib/timelineDomain'
import { safeDisplay } from '../../lib/evidenceText'
import { formatDateTime, formatElapsedMs, useDisplayZone } from '../../lib/time'
import { useI18n } from '../../i18n'

function trackLabel(track: TimelineTrack, builtinLabel: (idPrefix: string) => string): string {
  if (track.builtin) return builtinLabel(track.terminalId.slice(0, 4))
  return safeDisplay(`${track.shell ?? ''} ${track.pid ?? track.terminalId.slice(-6)}`.trim())
}

export interface TimelineCommandTracksProps {
  activeIds?: ReadonlySet<string> | null
  filtering?: boolean
  badgesById?: ReadonlyMap<string, readonly EventBadge[]>
  eventsById?: ReadonlyMap<string, RedLogEvent>
  selectedId?: string | null
  tabStopKey?: string
  didPan?: RefObject<boolean>
  onPick?: (mark: IntervalMark, detail: number) => void
  onOpen?: (mark: IntervalMark, how: 'dblclick' | 'key') => void
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
  set, marks, order, laneH, trackW, scrollLeft, rows, builtinLabel, selectedId, tabStopKey, didPan, onPick, onOpen, activeIds, filtering, badgesById, eventsById
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
    <div data-testid="timeline-command-tracks" className="contents">
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
            className="absolute left-0 w-full pointer-events-none" style={{ top: row * laneH, height: laneH }}>
            {own.map((mark) => {
              const iv = mark.intervals[0]
              const point = mark.kind === 'point'
              const cluster = mark.kind === 'cluster'
              const endX = point ? mark.x0 + 10 : mark.x1
              const dashed = mark.open > 0 || mark.startCap === 'unloaded'
              const lineEnd = point && mark.open > 0 ? Math.min(trackW, mark.x0 + OPEN_STUB_PX) : mark.x1
              const dimmed = !!activeIds && !mark.intervals.some(member => member.memberIds.some(id => activeIds.has(id)))
              const endRows = mark.intervals.flatMap(member => {
                const end = member.endId ? eventsById?.get(member.endId) : undefined
                return end ? [end] : []
              })
              const badges: EventBadge[] = []
              const badgeKeys = new Set<string>()
              const badgeReasons = new Set<string>()
              for (const member of mark.intervals) for (const id of member.memberIds) {
                for (const b of badgesById?.get(id) ?? []) {
                  badgeReasons.add(`${b.icon} ${b.reasonKey ? t(b.reasonKey) : b.reason ?? ''}`)
                  if (!badgeKeys.has(b.key)) { badgeKeys.add(b.key); badges.push(b) }
                }
              }
              const badgeTitle = [...badgeReasons].join('\n')
              // Full-chain failure must remain visible even when another member
              // was recovered. Preserve original order within each severity.
              const badge = badges.find(b => b.key === 'verify-broken') ?? badges.find(b => b.key === 'clock') ?? badges[0]
              const io = !cluster && endRows[0] ? ioMark(endRows[0]) : null
              const lines = mark.intervals.slice(0, 10).map(member => intervalTitle(member, label, t))
              if (mark.intervals.length > 10) lines.push(t('timeline.clusterMoreItems', { count: mark.intervals.length - 10 }))
              const title = lines.join('\n')
                + (badgeTitle ? '\n' + badgeTitle : '')
                + (io ? ioTitle(io, t) : '')
              const name = safeDisplay(iv.command.replace(/\s+/g, ' ').trim())
              const ringLeft = mark.x0 - (cluster ? 8 : 4)
              const ringRight = Math.max(lineEnd, cluster ? mark.x0 + (mark.failed ? 17 : 8) : mark.endCap === 'open' || mark.endCap === 'open-stub' ? mark.x0 + 4 : endX + 4)
              const selected = mark.intervals.some((member) => member.memberIds.includes(selectedId ?? ''))
              // Drawing remains in track coordinates inside a zero-sized origin.
              // Only the button is hit-tested; labels and overflow ink are not.
              return (
                <button type="button" key={mark.key} data-testid="timeline-interval-mark" data-mark-kind={mark.kind}
                  data-timeline-event data-timeline-interval
                  title={title} aria-label={`${title}${dimmed && filtering ? ` · ${t('timeline.notMatching')}` : ''}`} aria-pressed={selected || undefined}
                  aria-disabled={dimmed || undefined}
                  tabIndex={tabStopKey === mark.key ? 0 : -1}
                  className="absolute pointer-events-auto cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent"
                  style={{ left: mark.hitLeft, top: TRACK_LINE_Y - 13.5, width: mark.hitWidth, height: 27, opacity: dimmed ? 0.15 : 1, pointerEvents: dimmed ? 'none' : undefined }}
                  onClick={(e) => { if (!didPan?.current) onPick?.(mark, e.detail) }}
                  onDoubleClick={() => { if (!didPan?.current) onOpen?.(mark, 'dblclick') }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return
                    e.preventDefault(); e.stopPropagation()
                    if (cluster) onPick?.(mark, 0); else onOpen?.(mark, 'key')
                  }}>
                  <span data-testid="timeline-interval-selection" className={`absolute pointer-events-none rounded ${selected ? 'ring-2 ring-redlog-accent' : ''}`}
                    style={{ left: ringLeft - mark.hitLeft, top: cluster ? 5.5 : 9.5, width: ringRight - ringLeft, height: cluster ? 16 : 8 }} />
                  <span className="absolute pointer-events-none" style={{ left: -mark.hitLeft, top: 13.5 - TRACK_LINE_Y, width: 0, height: 0 }}>
                  {lineEnd > mark.x0 && (
                    <span data-timeline-mark={mark.startCap === 'unloaded' && !cluster || undefined} data-testid="timeline-interval-line" data-interval-id={mark.key} data-line={dashed ? 'dashed' : 'solid'}
                      className={`absolute border-t-2 border-redlog-text-dim ${dashed ? 'border-dashed' : ''}`}
                      style={{ left: mark.x0, width: lineEnd - mark.x0, top: TRACK_LINE_Y - 1 }} />
                  )}
                  {cluster ? (
                    <span data-timeline-mark data-testid="timeline-interval-count"
                      className={`absolute border bg-redlog-bg text-redlog-text font-mono text-xs leading-none rounded-full ${mark.open > 0 ? 'border-dashed' : ''}`}
                      style={{ left: mark.x0 - 8, top: TRACK_LINE_Y - 8, minWidth: 16, height: 16, textAlign: 'center' }}>
                      {mark.intervals.length}
                    </span>
                  ) : mark.startCap === 'mark' ? (
                    <span data-timeline-mark data-testid="timeline-start-mark" className="absolute rounded-full bg-redlog-text"
                      style={{ left: mark.x0 - 4, top: TRACK_LINE_Y - 4, width: 8, height: 8, transform: selected ? 'scale(1.3)' : undefined }} />
                  ) : null}
                  {(!cluster || mark.failed > 0) && <EndShape mark={mark} x={cluster ? mark.x0 + 13 : endX} y={TRACK_LINE_Y} />}
                  {/* A badge sits at the end's upper right (endX+4..+16); the
                      exit code moves clear of it rather than under it. */}
                  {!cluster && mark.endCap === 'failed' && freeAfter(positions, endX, trackW) >= (badge ? 32 : 20) && (
                    <span data-testid="timeline-exit-code" className="absolute font-mono text-xs leading-none text-redlog-text"
                      style={{ left: endX + (badge ? 20 : 8), top: TRACK_LINE_Y - 5 }}>{iv.exitCode}</span>
                  )}
                  {io && (io.io || io.fail) && <span data-interval-io title={ioTitle(io, t).replace(/^ · /, '')}
                    className="absolute pointer-events-none" style={{ left: endX - 4, top: TRACK_LINE_Y - 4, width: 8, height: 8 }}>
                    {io.fail && <span className="absolute rounded-full border border-redlog-danger" style={{ left: -2.5, top: -2.5, width: 13, height: 13, borderWidth: 1.5 }} />}
                    {io.io && <span className="absolute rounded-full" style={{ right: -1, bottom: -1, width: 3, height: 3, background: IO_MARK_COLOR[io.io] }} />}
                  </span>}
                  {badge && <span data-interval-badge title={badgeTitle}
                    className="absolute rounded-full bg-redlog-bg/95 border border-redlog-warn/60 text-xs leading-none flex items-center justify-center pointer-events-none"
                    style={{ left: (cluster || !iv.endId ? mark.x0 : endX) + 4, top: TRACK_LINE_Y - 12, width: 12, height: 12 }}>{badge.icon}</span>}
                  {mark.label && (
                    <span data-testid="timeline-interval-name" title={title} className="absolute block truncate whitespace-nowrap font-mono text-xs leading-none text-redlog-text"
                      style={{ left: mark.label.side === 'right' ? mark.x0 + 6 : mark.x0 - 6 - mark.label.maxW,
                        width: mark.label.maxW, maxWidth: mark.label.maxW, textAlign: mark.label.side === 'left' ? 'right' : 'left', top: point && badge ? TRACK_LINE_Y + 4 : TRACK_LINE_Y - 16 }}>
                      {name}
                    </span>
                  )}
                  </span>
                </button>
              )
            })}
            <span data-testid="timeline-track-label" className="absolute pointer-events-none whitespace-nowrap font-mono text-xs leading-none text-redlog-text-faint"
              style={{ left: scrollLeft + 4, top: 0 }}>{label}</span>
          </div>
        )
      })}
    </div>
  )
})
