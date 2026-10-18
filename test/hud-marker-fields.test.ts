import { describe, it, expect } from 'vitest'
import { hudMarkerFields } from '../src/main/ipc/markers'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

describe('hudMarkerFields', () => {
  it('times the marker at the click, not at save', () => {
    expect(hudMarkerFields({ at: NOW - 8_000 }, NOW).source_timestamp).toBe(NOW - 8_000)
  })

  it('does not believe a time in the future, in the distant past, or not a number', () => {
    for (const at of [NOW + 60_000, NOW - 2 * 24 * 3_600_000, NaN, '123', null, undefined]) {
      expect(hudMarkerFields({ at }, NOW).source_timestamp).toBe(NOW)
    }
  })

  it('names an empty title after the time and calls it a bare mark', () => {
    const f = hudMarkerFields({ title: '   ', notes: '' }, NOW)
    expect(f.title).toMatch(/^HUD mark /)
    expect(f.source).toBe('hud-instant')
  })

  it('keeps a title and notes, trimmed and bounded, and says they were filled in', () => {
    const f = hudMarkerFields({ title: '  login bypass  ', notes: 'x'.repeat(20_000) }, NOW)
    expect(f.title).toBe('login bypass')
    expect(f.notes).toHaveLength(10_000)
    expect(f.source).toBe('hud')
    expect(hudMarkerFields({ title: 't'.repeat(500) }, NOW).title).toHaveLength(200)
  })

  it('ignores a non-string title or notes', () => {
    const f = hudMarkerFields({ title: 42, notes: { a: 1 } }, NOW)
    expect(f.title).toMatch(/^HUD mark /)
    expect(f.notes).toBe('')
  })
})
