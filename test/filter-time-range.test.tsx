// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilterBar } from '../src/renderer/src/components/FilterBar'
import { FilterProvider, useSharedFilter, formatTimeRange } from '../src/renderer/src/lib/FilterContext'
import { toLocalInputValue, fromLocalInputValue, timeRangeError, windowAround } from '../src/renderer/src/lib/timeRangeInput'
import { setDisplayZone } from '../src/renderer/src/lib/time'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

// A blue team asking for "events on the 14th between 09:00 and 11:00" had no
// way to express it: the bar offered only "last 1h / 6h / 24h", each writing a
// FIXED `since` at the moment it was clicked. Twenty minutes later that
// condition was "since 15:03", not "the last hour" — the button said one
// thing, the query meant another, and the chip repeated the button.

let api: ReturnType<typeof useSharedFilter>
function Probe(): null { api = useSharedFilter(); return null }

const mount = (): void => {
  render(<I18nProvider><FilterProvider><Probe /><FilterBar /></FilterProvider></I18nProvider>)
}
const expand = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /Filter/i }))
}

const t = (k: string): string => k   // formatTimeRange only needs a passthrough

describe('an absolute time range can be asked for', () => {
  beforeEach(() => { installTimelineBridge(); setDisplayZone('local') })
  afterEach(() => { cleanup(); setDisplayZone('local') })

  it('sets a start and an end from the inputs', async () => {
    mount()
    await expand()
    fireEvent.change(screen.getByTestId('filter-time-since'), { target: { value: '2026-08-14T09:00' } })
    await waitFor(() => expect(api.filter.timeRange?.since).toBe(new Date(2026, 7, 14, 9, 0).getTime()))
    fireEvent.change(screen.getByTestId('filter-time-before'), { target: { value: '2026-08-14T11:00' } })
    await waitFor(() => expect(api.filter.timeRange?.before).toBe(new Date(2026, 7, 14, 11, 0).getTime()))
  })

  it('clearing both fields drops the condition rather than leaving an empty one', async () => {
    mount()
    await expand()
    fireEvent.change(screen.getByTestId('filter-time-since'), { target: { value: '2026-08-14T09:00' } })
    await waitFor(() => expect(api.filter.timeRange).not.toBeNull())
    fireEvent.change(screen.getByTestId('filter-time-since'), { target: { value: '' } })
    await waitFor(() => expect(api.filter.timeRange).toBeNull())
  })

  it('says when the end is at or before the start, rather than showing nothing', async () => {
    mount()
    await expand()
    fireEvent.change(screen.getByTestId('filter-time-since'), { target: { value: '2026-08-14T11:00' } })
    fireEvent.change(screen.getByTestId('filter-time-before'), { target: { value: '2026-08-14T09:00' } })
    expect(await screen.findByTestId('filter-time-invalid')).not.toBeNull()
  })

  it('round-trips a value through the displayed zone', () => {
    const ms = new Date(2026, 7, 14, 9, 30).getTime()
    expect(fromLocalInputValue(toLocalInputValue(ms))).toBe(ms)
    setDisplayZone('utc')
    const utcMs = Date.UTC(2026, 7, 14, 9, 30)
    expect(toLocalInputValue(utcMs)).toBe('2026-08-14T09:30')
    expect(fromLocalInputValue('2026-08-14T09:30')).toBe(utcMs)
  })

  it('reads an empty or half-typed field as no bound', () => {
    expect(fromLocalInputValue('')).toBeUndefined()
    expect(fromLocalInputValue('2026-08-')).toBeUndefined()
    expect(toLocalInputValue(undefined)).toBe('')
  })

  it('only calls a range invalid when the end is not after the start', () => {
    expect(timeRangeError({ since: 100, before: 200 })).toBeNull()
    expect(timeRangeError({ since: 100 })).toBeNull()
    expect(timeRangeError({ before: 200 })).toBeNull()
    expect(timeRangeError({ since: 200, before: 200 })).toBe('end-before-start')
    expect(timeRangeError({ since: 300, before: 200 })).toBe('end-before-start')
  })

  it('opens a window around one event', () => {
    const w = windowAround(1_700_000_000_000)
    expect(w.before - w.since).toBe(10 * 60_000)
    expect(w.since).toBeLessThan(1_700_000_000_000)
  })
})

// The chip repeated the button, so it kept saying "last 1h" about a condition
// that had become "since 15:03". It names the absolute window now — with the
// date whenever time-of-day alone would be a puzzle.
describe('the time chip names the window the query actually holds', () => {
  beforeEach(() => setDisplayZone('local'))
  afterEach(() => setDisplayZone('local'))

  const at = (d: number, h: number, mi = 0): number => new Date(2026, 7, d, h, mi).getTime()

  it('keeps it short for a range inside today', () => {
    const now = Date.now()
    const label = formatTimeRange({ since: now - 3600_000, before: now }, t)
    expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(label).toMatch(/\d{2}:\d{2}/)
  })

  it('carries the date across a day boundary', () => {
    const label = formatTimeRange({ since: at(14, 23, 40), before: at(15, 1, 10) }, t)
    expect(label).toContain('2026-08-14')
    expect(label).toContain('2026-08-15')
  })

  it('carries the date for a past day, even within it', () => {
    expect(formatTimeRange({ since: at(14, 9), before: at(14, 11) }, t)).toContain('2026-08-14')
  })

  it('says nothing for an empty range', () => {
    expect(formatTimeRange({}, t)).toBe('')
  })
})
