// The two things on the Timeline that change with the wall clock rather than
// with the rows: the follow badge's "Xm behind" and the current-time line.
// Each keeps its own one-second tick. The tick used to live in the panel, which
// re-rendered all of it (every dot, card and strip) once a second to move one
// label and one line.

import { useEffect, useState } from 'react'
import { formatBehind } from '../../lib/timelineDomain'

type Translate = (key: string, vars?: Record<string, string | number>) => string

function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** LIVE while following at the right edge; otherwise how far behind the
 *  newest loaded row the operator is, and a click takes follow back. */
export function FollowBadge({ latestTs, isLive, onPause, onResume, t }: {
  latestTs: number
  isLive: boolean
  onPause: () => void
  onResume: () => void
  t: Translate
}): JSX.Element {
  const now = useSecondClock()
  const behindMs = Math.max(0, now - latestTs)
  return (
    <button
      data-testid="timeline-follow-badge"
      onClick={() => { if (isLive) onPause(); else onResume() }}
      title={isLive ? t('timeline.follow.pauseHint') : t('timeline.follow.resumeHint', { time: formatBehind(behindMs) })}
      className={`whitespace-nowrap text-xs font-mono px-1.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
        isLive
          ? 'text-emerald-100 bg-emerald-600/40 ring-1 ring-emerald-500/40'
          : 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
      }`}
    >{isLive ? t('timeline.follow.live') : t('timeline.follow.behindFmt', { time: formatBehind(behindMs) })}</button>
  )
}

/** The current-time line, while the present is inside the drawn domain. */
export function NowLine({ timeStart, timeEnd, toX, height }: {
  timeStart: number
  timeEnd: number
  toX: (ts: number) => number
  height: number
}): JSX.Element | null {
  const now = useSecondClock()
  if (now < timeStart || now > timeEnd) return null
  return <div className="absolute top-0 w-px bg-red-500/70" style={{ left: toX(now), height }} />
}
