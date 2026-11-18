import { formatDate, formatDateTime, formatTime } from './time'

/** When something was seen, as short as is still unambiguous on a
 *  multi-day project: today is the time alone, to the second; another day
 *  carries its date, and the year only when it is not this year's. */
export function formatSeen(ms: number, now = Date.now()): string {
  const day = formatDate(ms)
  if (day === formatDate(now)) return formatTime(ms, { seconds: true })
  return formatDateTime(ms, { year: day.slice(0, 4) !== formatDate(now).slice(0, 4) })
}

/** First–last seen. The end drops the date it shares with the start. */
export function formatSeenRange(first: number, last: number, now = Date.now()): string {
  const start = formatSeen(first, now)
  if (first === last) return start
  const sameDay = formatDate(first) === formatDate(last)
  const end = sameDay && formatDate(last) !== formatDate(now) ? formatTime(last) : formatSeen(last, now)
  return `${start} – ${end}`
}
