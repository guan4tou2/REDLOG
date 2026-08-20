// One place that decides what a timestamp looks like (docs/UIUX-STANDARD.md §9).
//
// Three rules, and each existed because the app was breaking it:
//
//   24-hour, always. Bare `toLocaleTimeString()` renders "3:04:05 PM" for
//   anyone whose locale says so, and a red-team log that mixes 3:04 PM with
//   15:04 is a log an auditor has to reason about instead of read.
//
//   Relative time is for freshness only — "last checked 3s ago", where the
//   age *is* the information. An event, an axis tick, a transcript line and
//   anything exported carries an absolute time, because "2 hours ago" stops
//   being true the moment it is written down, and these are records.
//
//   Exports are ISO 8601. Whatever reads them next is not a person.
//
// Deliberately not wired to the Timeline's `formatTs`: that one also resolves
// the operator's Local/UTC/Project zone choice, which is a Timeline concept.
// It applies the same 24-hour rule.

const pad = (n: number): string => String(n).padStart(2, '0')

/** `15:04`, or `15:04:05` with seconds. */
export function formatTime(ms: number, opts: { seconds?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return opts.seconds ? `${base}:${pad(d.getSeconds())}` : base
}

/** `2026-08-20 15:04`, or with seconds. Sortable as text, which the
 *  locale-ordered forms are not. */
export function formatDateTime(ms: number, opts: { seconds?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${date} ${formatTime(ms, opts)}`
}

/** ISO 8601 with the offset — for anything leaving the app. */
export function formatIso(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toISOString()
}

/**
 * Age, for freshness fields only. Everything else takes an absolute time.
 * `t` is passed in rather than imported so the strings stay translatable and
 * this module stays free of React.
 */
export function formatFreshness(
  ms: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
  now: number = Date.now()
): string {
  if (!Number.isFinite(ms)) return ''
  const secs = Math.max(0, Math.round((now - ms) / 1000))
  if (secs < 5) return t('time.justNow')
  if (secs < 60) return t('time.sAgo', { s: secs })
  const mins = Math.floor(secs / 60)
  if (mins < 60) return t('time.mAgo', { m: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('time.hAgo', { h: hours })
  return t('time.dAgo', { d: Math.floor(hours / 24) })
}
