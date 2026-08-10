import { describe, it, expect } from 'vitest'
import { resolveTimelineKey } from '../src/renderer/src/lib/timelineKeys'
import type { TimelineKeyContext } from '../src/renderer/src/lib/timelineKeys'

// The Timeline shipped FOUR separate global keydown listeners, each with its own
// copy of the "am I typing in a field?" guard, and Escape was bound in three of
// them. With the detail panel, the help modal and focus-chain mode all open, one
// Escape press fired all three handlers at once — the operator could not predict
// what Escape would do. resolveTimelineKey makes the whole key surface ONE pure
// decision with an explicit precedence, so it can be reasoned about and tested.

const CTX = (over: Partial<TimelineKeyContext> = {}): TimelineKeyContext => ({
  inField: false,
  hasDetail: false,
  helpOpen: false,
  focusActive: false,
  ...over
})
const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })

describe('resolveTimelineKey', () => {
  it('does nothing while the operator is typing in a field', () => {
    // Every legacy handler bailed on inputs so `/` inside a shell command or the
    // search box was never hijacked. That guard now lives in exactly one place.
    for (const k of ['/', '?', 'f', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(resolveTimelineKey(key(k), CTX({ inField: true, hasDetail: true, helpOpen: true, focusActive: true })))
        .toBe('none')
    }
  })

  describe('Escape precedence — the modal wins, then focus, then detail', () => {
    it('closes the help modal first when everything is open', () => {
      expect(resolveTimelineKey(key('Escape'), CTX({ helpOpen: true, focusActive: true, hasDetail: true })))
        .toBe('close-help')
    })
    it('exits focus mode when help is closed', () => {
      expect(resolveTimelineKey(key('Escape'), CTX({ focusActive: true, hasDetail: true })))
        .toBe('exit-focus')
    })
    it('closes the detail panel when nothing else is open', () => {
      expect(resolveTimelineKey(key('Escape'), CTX({ hasDetail: true })))
        .toBe('close-detail')
    })
    it('does nothing on Escape with no open surface', () => {
      expect(resolveTimelineKey(key('Escape'), CTX())).toBe('none')
    })
  })

  describe('single-key affordances require no modifier', () => {
    it('/ focuses the filter', () => {
      expect(resolveTimelineKey(key('/'), CTX())).toBe('focus-filter')
    })
    it('/ with ⌘ is left alone (so ⌘-shortcuts pass through)', () => {
      expect(resolveTimelineKey(key('/', { metaKey: true }), CTX())).toBe('none')
    })
    it('? toggles the help modal', () => {
      expect(resolveTimelineKey(key('?'), CTX())).toBe('toggle-help')
    })
    it('f toggles focus-chain mode, upper- or lower-case', () => {
      expect(resolveTimelineKey(key('f'), CTX())).toBe('toggle-focus')
      expect(resolveTimelineKey(key('F'), CTX())).toBe('toggle-focus')
    })
    it('f with ctrl/meta/alt is left alone (no collision with ⌘F)', () => {
      expect(resolveTimelineKey(key('f', { metaKey: true }), CTX())).toBe('none')
      expect(resolveTimelineKey(key('f', { ctrlKey: true }), CTX())).toBe('none')
      expect(resolveTimelineKey(key('f', { altKey: true }), CTX())).toBe('none')
    })
  })

  describe('arrow navigation only when a detail panel is open', () => {
    it('walks the selected event up/down when detail is open', () => {
      expect(resolveTimelineKey(key('ArrowUp'), CTX({ hasDetail: true }))).toBe('nav-prev')
      expect(resolveTimelineKey(key('ArrowDown'), CTX({ hasDetail: true }))).toBe('nav-next')
    })
    it('does nothing on arrows with no detail panel (normal scroll is left intact)', () => {
      expect(resolveTimelineKey(key('ArrowUp'), CTX())).toBe('none')
      expect(resolveTimelineKey(key('ArrowDown'), CTX())).toBe('none')
    })
  })

  it('ignores unrelated keys', () => {
    expect(resolveTimelineKey(key('a'), CTX({ hasDetail: true }))).toBe('none')
    expect(resolveTimelineKey(key('Enter'), CTX({ hasDetail: true }))).toBe('none')
  })
})
