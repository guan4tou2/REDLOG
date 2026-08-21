import { describe, it, expect } from 'vitest'
import {
  MODE_SETTINGS, modeFor, isLocked, adjust, type TimelineSettings
} from '../src/renderer/src/lib/timelineModes'

// §6's three modes, replacing eight side-by-side toggles. Eight booleans is
// 256 states; an operator who arrived at one of them had no way to tell
// whether it was a sensible place to be.

describe('timeline view modes', () => {
  it('round-trips every mode through its settings', () => {
    for (const mode of ['working', 'audit', 'debug'] as const) {
      expect(modeFor(MODE_SETTINGS[mode]), mode).toBe(mode)
    }
  })

  it('gives the three modes genuinely different settings', () => {
    // If two presets coincided, `modeFor` would answer whichever came first
    // and one of the three would be unreachable.
    const seen = new Set(Object.values(MODE_SETTINGS).map((s) => JSON.stringify(s)))
    expect(seen.size).toBe(3)
  })

  it('never compresses time in audit', () => {
    // A gap is evidence about when nothing happened. Squeezing it is editing
    // the record, which is exactly what an audit view must not do.
    expect(MODE_SETTINGS.audit.compressGaps).toBe(false)
    expect(MODE_SETTINGS.audit.collapseAgentTurns).toBe(false)
  })

  it('pins audit to UTC', () => {
    // A report read in another country must not depend on where it was written.
    expect(MODE_SETTINGS.audit.tz).toBe('utc')
  })

  it('shows only chained events in audit, and everything in debug', () => {
    expect(MODE_SETTINGS.audit.auditorView).toBe(true)
    expect(MODE_SETTINGS.debug.auditorView).toBe(false)
    expect(MODE_SETTINGS.debug.sessionDividers).toBe(true)
  })

  it('locks audit and nothing else', () => {
    expect(isLocked('audit')).toBe(true)
    expect(isLocked('working')).toBe(false)
    expect(isLocked('debug')).toBe(false)
  })

  it('stops calling itself audit once a setting is adjusted', () => {
    // The whole point of locking: a claim you can quietly tweak is not a
    // claim. If an adjustment does get through, the view must lose the label
    // rather than keep it while no longer meaning it.
    const adjusted = adjust(MODE_SETTINGS.audit, 'compressGaps', true)
    expect(modeFor(adjusted)).toBeNull()
  })

  it('reports no mode for a combination that matches none', () => {
    const custom: TimelineSettings = {
      ...MODE_SETTINGS.working, sessionDividers: true, tz: 'project'
    }
    expect(modeFor(custom)).toBeNull()
  })
})
