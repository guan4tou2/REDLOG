// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

type TimeModule = typeof import('../src/renderer/src/lib/time')

// The zone is read once and then held, so each case starts from a fresh
// module, as a fresh window would.
async function freshTime(): Promise<TimeModule> {
  vi.resetModules()
  return import('../src/renderer/src/lib/time')
}

const AT = Date.UTC(2026, 8, 24, 7, 4, 5) // 2026-09-24 07:04:05Z
const pad = (n: number): string => String(n).padStart(2, '0')
const here = new Date(AT)
const LOCAL_TIME = `${pad(here.getHours())}:${pad(here.getMinutes())}`
const LOCAL_DATE = `${here.getFullYear()}-${pad(here.getMonth() + 1)}-${pad(here.getDate())}`

beforeEach(() => { localStorage.clear() })

// Spec 038 US5: one display zone, Local or UTC, for every surface that prints
// an event time. The Timeline had its own Local / UTC / Project picker, and
// no other view knew about it.
describe('one display zone', () => {
  it('prints local time by default, unmarked', async () => {
    const time = await freshTime()
    expect(time.getDisplayZone()).toBe('local')
    expect(time.formatTime(AT)).toBe(LOCAL_TIME)
    expect(time.formatTime(AT, { seconds: true })).toBe(`${LOCAL_TIME}:${pad(here.getSeconds())}`)
    expect(time.formatDate(AT)).toBe(LOCAL_DATE)
    expect(time.formatDateTime(AT)).toBe(`${LOCAL_DATE} ${LOCAL_TIME}`)
  })

  it('prints UTC, marked Z, once the zone is UTC', async () => {
    const time = await freshTime()
    time.setDisplayZone('utc')
    expect(time.getDisplayZone()).toBe('utc')
    expect(time.formatTime(AT)).toBe('07:04Z')
    expect(time.formatTime(AT, { seconds: true })).toBe('07:04:05Z')
    expect(time.formatDate(AT)).toBe('2026-09-24Z')
    expect(time.formatDateTime(AT)).toBe('2026-09-24 07:04Z')
    expect(time.formatDateTime(AT, { seconds: true })).toBe('2026-09-24 07:04:05Z')
    expect(localStorage.getItem('redlog-display-zone')).toBe('utc')
  })

  // Exports stay ISO 8601 whatever the zone: they are written in the main
  // process, which must never read this renderer preference.
  it('is not read where exports are written', () => {
    const offenders = glob.sync('src/{core,main}/**/*.ts', { cwd: path.join(__dirname, '..'), absolute: true })
      .filter((f) => /renderer\/src\/lib\/time|DisplayZone|redlog-display-zone/.test(fs.readFileSync(f, 'utf-8')))
    expect(offenders).toEqual([])
  })

  // FR-013: an operator's Timeline choice of UTC carries over. FR-014: nothing
  // could set a project zone, so a stored "project" was always Local.
  for (const [old, zone] of [['utc', 'utc'], ['project', 'local'], ['local', 'local']] as const) {
    it(`carries the Timeline's "${old}" over as ${zone}`, async () => {
      localStorage.setItem('redlog-timeline-tz', old)
      const time = await freshTime()
      expect(time.getDisplayZone()).toBe(zone)
      expect(localStorage.getItem('redlog-display-zone')).toBe(zone)
    })
  }

  it('prefers the zone already chosen over the old Timeline setting', async () => {
    localStorage.setItem('redlog-display-zone', 'local')
    localStorage.setItem('redlog-timeline-tz', 'utc')
    const time = await freshTime()
    expect(time.getDisplayZone()).toBe('local')
  })

  it('re-renders a subscriber when the zone changes, here or in another window', async () => {
    const time = await freshTime()
    const { result } = renderHook(() => time.useDisplayZone())
    expect(result.current).toBe('local')
    act(() => time.setDisplayZone('utc'))
    expect(result.current).toBe('utc')
    // The HUD is another window: it hears of the change through `storage`.
    act(() => {
      localStorage.setItem('redlog-display-zone', 'local')
      window.dispatchEvent(new StorageEvent('storage', { key: 'redlog-display-zone', newValue: 'local' }))
    })
    expect(result.current).toBe('local')
    expect(time.formatTime(AT)).toBe(LOCAL_TIME)
  })
})
