import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { repoRelative } from './helpers/repo-path'
import glob from 'fast-glob'
import { formatTime, formatDateTime, formatIso, formatFreshness } from '../src/renderer/src/lib/time'

const ROOT = path.join(__dirname, '..')
const at = (iso: string): number => new Date(iso).getTime()

describe('time formatting', () => {
  it('is 24-hour, always', () => {
    // The failure this guards against is locale-shaped and therefore invisible
    // on the machine of whoever writes the code: `toLocaleTimeString()` gives
    // "3:04 PM" under en-US and "15:04" under most others, so a log could mix
    // both and nobody in the room would see it.
    const afternoon = at('2026-08-20T15:04:05')
    expect(formatTime(afternoon)).toBe('15:04')
    expect(formatTime(afternoon, { seconds: true })).toBe('15:04:05')
    expect(formatTime(afternoon)).not.toMatch(/AM|PM/i)
  })

  it('pads every field so times line up in a column', () => {
    expect(formatTime(at('2026-08-20T09:07:03'), { seconds: true })).toBe('09:07:03')
    expect(formatDateTime(at('2026-01-02T09:07:03'))).toBe('2026-01-02 09:07')
  })

  it('orders date parts big-endian, so text sort is chronological sort', () => {
    const a = formatDateTime(at('2026-01-02T00:00:00'))
    const b = formatDateTime(at('2026-01-10T00:00:00'))
    const c = formatDateTime(at('2026-02-01T00:00:00'))
    expect([c, b, a].sort()).toEqual([a, b, c])
  })

  it('exports ISO 8601', () => {
    expect(formatIso(at('2026-08-20T15:04:05Z'))).toBe('2026-08-20T15:04:05.000Z')
  })

  it('survives a non-finite timestamp instead of rendering "Invalid Date"', () => {
    for (const fn of [formatTime, formatDateTime, formatIso]) {
      expect(fn(NaN)).toBe('')
      expect(fn(Infinity)).toBe('')
    }
  })

  it('steps freshness through the right unit', () => {
    const t = (key: string, vars?: Record<string, string | number>): string =>
      `${key}${vars ? JSON.stringify(vars) : ''}`
    const now = at('2026-08-20T12:00:00')
    const ago = (secs: number): string => formatFreshness(now - secs * 1000, t, now)
    expect(ago(2)).toBe('time.justNow')
    expect(ago(30)).toBe('time.sAgo{"s":30}')
    expect(ago(90)).toBe('time.mAgo{"m":1}')
    expect(ago(3 * 3600)).toBe('time.hAgo{"h":3}')
    expect(ago(50 * 3600)).toBe('time.dAgo{"d":2}')
    // A clock that jumped backwards must not render "-4s ago".
    expect(formatFreshness(now + 4000, t, now)).toBe('time.justNow')
  })
})

describe('no component formats its own time', () => {
  const sources = (): Array<[string, string]> =>
    glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })
      .map((f) => [repoRelative(ROOT, f), fs.readFileSync(f, 'utf-8')] as [string, string])

  it('never calls a bare toLocale*String', () => {
    // `toLocaleTimeString()` with no options is the 12-hour bug. Timeline's
    // `formatTs` may still call the localised forms — it also resolves the
    // operator's UTC/Project zone choice — but it passes `hour12: false`.
    const offenders = sources()
      .filter(([f]) => !f.endsWith('lib/time.ts'))
      .flatMap(([f, src]) =>
        [...src.matchAll(/(.{0,40})\.toLocale(Time|Date)?String\(([^)]*)\)/g)]
          .filter(([, before, kind, args]) =>
            // `toLocaleString()` is also how a *number* gets its thousands
            // separators, which is not a time and not this rule's business.
            (kind !== undefined || /Date\(/.test(before)) && !/hour12:\s*false/.test(args))
          .map(([full]) => `${f}: ${full.trim()}`)
      )
    expect(offenders).toEqual([])
  })

  it('keeps relative time to freshness fields', () => {
    // §9: an event, an axis tick, a transcript line or anything exported is a
    // record, and "2 hours ago" stops being true the moment it is written.
    // One implementation means one place where that rule can be broken.
    const localAgo = sources()
      .filter(([f]) => !f.endsWith('lib/time.ts'))
      .filter(([, src]) => /function\s+\w*[tT]imeAgo|const\s+\w*[tT]imeAgo\s*=\s*\(/.test(src))
      .map(([f]) => f)
    expect(localAgo).toEqual([])
  })
})
