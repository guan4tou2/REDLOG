import { describe, it, expect, vi, afterEach } from 'vitest'
import { hudMarkerFields, hudDraftBelongsHere } from '../src/main/ipc/markers'

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

  it('stores an empty title as the fixed `HUD mark` and calls it a bare mark', () => {
    const f = hudMarkerFields({ title: '   ', notes: '' }, NOW)
    expect(f.title).toBe('HUD mark')
    expect(f.source).toBe('hud-instant')
  })

  describe('the default title is the same on every machine', () => {
    const tz = process.env.TZ
    afterEach(() => {
      vi.restoreAllMocks()
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz
    })

    it('does not depend on the time zone', () => {
      for (const zone of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
        process.env.TZ = zone
        expect(hudMarkerFields({}, NOW).title).toBe('HUD mark')
      }
    })

    it('does not call any locale-dependent time formatter', () => {
      const time = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('6:00:07 PM')
      const str = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('x')
      expect(hudMarkerFields({ title: '' }, NOW).title).toBe('HUD mark')
      expect(time).not.toHaveBeenCalled()
      expect(str).not.toHaveBeenCalled()
    })
  })

  it('leaves a title the operator typed as it is, apart from trimming', () => {
    expect(hudMarkerFields({ title: 'HUD mark 10:00:00' }, NOW).title).toBe('HUD mark 10:00:00')
    expect(hudMarkerFields({ title: ' pivot ' }, NOW).title).toBe('pivot')
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
    expect(f.title).toBe('HUD mark')
    expect(f.notes).toBe('')
  })
})

describe('hudDraftBelongsHere', () => {
  it('accepts a draft started in the project that is open now', () => {
    expect(hudDraftBelongsHere('eng-a', 'eng-a')).toBe(true)
  })
  it('refuses a draft started in a different project', () => {
    expect(hudDraftBelongsHere('eng-a', 'eng-b')).toBe(false)
  })
  it('accepts an unbound call, as before', () => {
    expect(hudDraftBelongsHere(undefined, 'eng-b')).toBe(true)
  })
})
