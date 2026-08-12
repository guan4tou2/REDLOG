import { describe, it, expect } from 'vitest'
import en from '../src/renderer/src/i18n/en.json'
import { emptyStateFor } from '../src/renderer/src/lib/emptyState'
import type { EmptyView } from '../src/renderer/src/lib/emptyState'

// emptyStateFor is the pure decision seam behind UX-AUDIT F4: given a view and
// the capture context, it returns which existing i18n keys describe the empty
// state and what the single call-to-action should be. It reuses i18n keys that
// already ship (asserted below against en.json) and emits stable, non-i18n
// action identifiers that the wiring step resolves to labels later.

// Every title/subtitle key this seam returns must already exist in en.json — the
// seam is forbidden from inventing new i18n keys (they would collide with the
// live i18n file). Action labelKeys are deliberately NOT in en.json yet.
const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(en, k)

const ALL_VIEWS: EmptyView[] = ['timeline', 'screenshots', 'targets', 'loot', 'marks', 'transcript']

describe('emptyStateFor — reuses existing i18n keys', () => {
  for (const captureDark of [false, true]) {
    for (const view of ALL_VIEWS) {
      it(`${view} (captureDark=${captureDark}) titleKey + subtitleKey exist in en.json`, () => {
        const m = emptyStateFor(view, { captureDark })
        expect(hasKey(m.titleKey), `titleKey ${m.titleKey} missing from en.json`).toBe(true)
        expect(hasKey(m.subtitleKey), `subtitleKey ${m.subtitleKey} missing from en.json`).toBe(true)
      })
    }
  }

  // Post-wiring (Wave 2-B): the action labelKeys now exist in en.json — the
  // views render them via t(). This guards i18n completeness for every CTA the
  // seam can emit, so a new action target can't ship without its copy.
  it('every action labelKey resolves to an i18n key', () => {
    for (const view of ALL_VIEWS) {
      for (const captureDark of [false, true]) {
        const a = emptyStateFor(view, { captureDark }).action
        if (a) expect(hasKey(a.labelKey), `${a.labelKey} missing from en.json`).toBe(true)
      }
    }
  })
})

describe('emptyStateFor — per-view mapping (light capture)', () => {
  const ctx = { captureDark: false }

  it('timeline: reuses noEvents/noEventsDesc and has NO action until events arrive', () => {
    const m = emptyStateFor('timeline', ctx)
    expect(m.titleKey).toBe('timeline.noEvents')
    expect(m.subtitleKey).toBe('timeline.noEventsDesc')
    expect(m.action).toBeUndefined()
  })

  it('screenshots: reuses empty/emptyDesc and CTAs to capture now', () => {
    const m = emptyStateFor('screenshots', ctx)
    expect(m.titleKey).toBe('screenshots.empty')
    expect(m.subtitleKey).toBe('screenshots.emptyDesc')
    expect(m.action).toEqual({ labelKey: 'empty.action.captureNow', target: 'screenshot' })
  })

  it('targets: reuses empty/subtitle and CTAs to the doc', () => {
    const m = emptyStateFor('targets', ctx)
    expect(m.titleKey).toBe('targets.empty')
    expect(m.subtitleKey).toBe('targets.subtitle')
    expect(m.action).toEqual({ labelKey: 'empty.action.learnMore', target: 'doc' })
  })

  it('loot: reuses empty/emptyDesc and CTAs to set up capture', () => {
    const m = emptyStateFor('loot', ctx)
    expect(m.titleKey).toBe('loot.empty')
    expect(m.subtitleKey).toBe('loot.emptyDesc')
    expect(m.action).toEqual({ labelKey: 'empty.action.setupCapture', target: 'dashboard' })
  })

  it('marks: reuses empty/placeholderSub and CTAs to the mark shortcut', () => {
    const m = emptyStateFor('marks', ctx)
    expect(m.titleKey).toBe('marks.empty')
    expect(m.subtitleKey).toBe('marks.placeholderSub')
    expect(m.action).toEqual({ labelKey: 'empty.action.mark', target: 'marker' })
  })

  it('transcript: reuses transcript.empty + a shared events subtitle and CTAs to the doc', () => {
    const m = emptyStateFor('transcript', ctx)
    expect(m.titleKey).toBe('transcript.empty')
    expect(m.subtitleKey).toBe('timeline.noEventsDesc')
    expect(m.action).toEqual({ labelKey: 'empty.action.learnMore', target: 'doc' })
  })
})

describe('emptyStateFor — capture-dark variant redirects to set up capture', () => {
  const ctx = { captureDark: true }

  it('timeline: dark timeline now has a set-up-capture CTA (nothing will arrive otherwise)', () => {
    const m = emptyStateFor('timeline', ctx)
    expect(m.titleKey).toBe('timeline.noEvents')
    expect(m.action).toEqual({ labelKey: 'empty.action.setupCapture', target: 'dashboard' })
  })

  it('loot/targets/transcript/marks all redirect to dashboard when capture is dark', () => {
    for (const view of ['loot', 'targets', 'transcript', 'marks'] as EmptyView[]) {
      const m = emptyStateFor(view, ctx)
      expect(m.action, `${view} should route to setup capture when dark`).toEqual({
        labelKey: 'empty.action.setupCapture',
        target: 'dashboard'
      })
    }
  })

  it('screenshots keeps its capture-now CTA even when dark (it IS a capture source)', () => {
    const m = emptyStateFor('screenshots', ctx)
    expect(m.action).toEqual({ labelKey: 'empty.action.captureNow', target: 'screenshot' })
  })

  it('titleKey/subtitleKey are unaffected by captureDark', () => {
    for (const view of ALL_VIEWS) {
      const light = emptyStateFor(view, { captureDark: false })
      const dark = emptyStateFor(view, { captureDark: true })
      expect(dark.titleKey).toBe(light.titleKey)
      expect(dark.subtitleKey).toBe(light.subtitleKey)
    }
  })
})
