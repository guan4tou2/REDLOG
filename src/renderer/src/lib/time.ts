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
// The display zone lives here too (spec 038). The Timeline kept its own
// Local / UTC / Project picker and its own formatter, so one event could read
// 15:04 on the Timeline and 07:04Z nowhere else, and this module did not know
// timestamps could have a zone at all. Now one zone, chosen in Settings ▸
// General, is read by the only event-time printers, the three below. A UTC
// time carries `Z`, because a UTC time that does not say so is a time you
// have to ask someone about; a local time is unmarked.

import { useSyncExternalStore } from 'react'

const pad = (n: number): string => String(n).padStart(2, '0')

// ── Display zone ─────────────────────────────────────────────────────────────
//
// A per-machine viewing preference, not project evidence: exports stay ISO
// 8601 whatever it is. Held in memory after the first read, because every row
// of every list prints through here.

export type DisplayZone = 'local' | 'utc'

const ZONE_KEY = 'redlog-display-zone'
/** The Timeline's own picker, before the zone was app-wide. */
const TIMELINE_TZ_KEY = 'redlog-timeline-tz'

let zone: DisplayZone | null = null
const listeners = new Set<() => void>()

function readZone(): DisplayZone {
  try {
    const stored = localStorage.getItem(ZONE_KEY)
    if (stored === 'local' || stored === 'utc') return stored
    // First read: the Timeline's choice carries over. Its "project" zone
    // could never be set, so it always printed Local.
    const legacy = localStorage.getItem(TIMELINE_TZ_KEY)
    if (legacy !== null) {
      const carried: DisplayZone = legacy === 'utc' ? 'utc' : 'local'
      localStorage.setItem(ZONE_KEY, carried)
      return carried
    }
  } catch { /* storage unavailable: Local */ }
  return 'local'
}

function changeZone(next: DisplayZone): void {
  if (zone === next) return
  zone = next
  for (const listener of listeners) listener()
}

export function getDisplayZone(): DisplayZone {
  if (zone === null) zone = readZone()
  return zone
}

export function setDisplayZone(next: DisplayZone): void {
  try { localStorage.setItem(ZONE_KEY, next) } catch { /* this window still follows it */ }
  changeZone(next)
}

// The HUD is another window. `storage` fires there, never in the window that
// wrote, so the one that changed it has already heard through setDisplayZone.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === ZONE_KEY) changeZone(readZone())
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The zone, for a surface that stays mounted while it changes: the caller
 *  re-renders, and so reprints, when it does. */
export function useDisplayZone(): DisplayZone {
  return useSyncExternalStore(subscribe, getDisplayZone, getDisplayZone)
}

interface Clock { utc: boolean; y: number; mo: number; d: number; h: number; mi: number; s: number }

/** The wall-clock fields of `ms` in the display zone. */
function clock(ms: number): Clock {
  const t = new Date(ms)
  return getDisplayZone() === 'utc'
    ? { utc: true, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() }
    : { utc: false, y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() }
}

const hm = (c: Clock, seconds?: boolean): string => `${pad(c.h)}:${pad(c.mi)}${seconds ? `:${pad(c.s)}` : ''}`
const ymd = (c: Clock, year = true): string => `${year ? `${c.y}-` : ''}${pad(c.mo)}-${pad(c.d)}`
const mark = (c: Clock): string => (c.utc ? 'Z' : '')

/** `15:04`, or `15:04:05` with seconds. `07:04Z` in UTC. */
export function formatTime(ms: number, opts: { seconds?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return ''
  const c = clock(ms)
  return `${hm(c, opts.seconds)}${mark(c)}`
}

/** `2026-08-20` — date only, for compact display. `2026-08-20Z` in UTC: the
 *  day is UTC's, which is not the local one near midnight. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const c = clock(ms)
  return `${ymd(c)}${mark(c)}`
}

/** `2026-08-20 15:04`, or with seconds. `2026-08-20 07:04Z` in UTC. Sortable
 *  as text, which the locale-ordered forms are not. `year: false` is for an
 *  axis tick, `08-20 15:04`. */
export function formatDateTime(ms: number, opts: { seconds?: boolean; year?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return ''
  const c = clock(ms)
  return `${ymd(c, opts.year !== false)} ${hm(c, opts.seconds)}${mark(c)}`
}

/**
 * Age, for freshness fields only. Everything else takes an absolute time.
 * `t` is passed in rather than imported, so the strings stay translatable
 * without this module reaching into the i18n context.
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

/** Human-readable byte size: `1.2 MB`, `340 KB`, etc. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
