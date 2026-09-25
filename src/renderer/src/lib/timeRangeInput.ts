import { getDisplayZone } from './time'

// Absolute start/end for the shared time filter.
//
// The bar offered only "last 1h / 6h / 24h", and each wrote a FIXED `since` at
// the moment it was clicked. Twenty minutes later that condition was "since
// 15:03", not "the last hour" — the button said one thing and the query meant
// another, and the chip repeated the button. A fixed window is the right
// behaviour for an investigation (a result set that silently slides while you
// read it is worse), so the fix is to say so: presets snapshot, and every
// label names the absolute window they produced.
//
// A blue team asking for "events on the 14th between 09:00 and 11:00" had no
// way to express it at all.
//
// `datetime-local` has no zone of its own — it is a wall-clock string — so
// these convert against the zone the rest of the UI is displaying in, which
// is what makes the input agree with the timestamps beside it.

/** `2026-08-20T14:05`, the value a `datetime-local` input takes. */
export function toLocalInputValue(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const utc = getDisplayZone() === 'utc'
  const p = (n: number): string => String(n).padStart(2, '0')
  return utc
    ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The epoch ms a `datetime-local` value means in the displayed zone, or
 *  undefined when the field is empty or half-typed. */
export function fromLocalInputValue(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)] as const
  const ms = getDisplayZone() === 'utc'
    ? Date.UTC(...parts)
    : new Date(...parts).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/** Is this a range a query can be run with? An end before its start is the
 *  one way to ask for nothing at all, and it must be said rather than
 *  silently returning an empty view that looks like an empty project. */
export function timeRangeError(
  range: { since?: number; before?: number }
): 'end-before-start' | null {
  if (range.since !== undefined && range.before !== undefined && range.before <= range.since) {
    return 'end-before-start'
  }
  return null
}

/** The window around one event, for "show me what else was happening". */
export function windowAround(timestamp: number, minutes = 5): { since: number; before: number } {
  const half = minutes * 60_000
  return { since: timestamp - half, before: timestamp + half }
}
