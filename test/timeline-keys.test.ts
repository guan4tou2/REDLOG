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
const key = (
  k: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}
) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

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

  // Arrows used to require an open detail panel and walked a flat list. §6
  // separates the two: the selection is its own thing, so an operator can walk
  // the timeline without a panel covering a third of it, and the axes mean
  // different questions — ← → reads one producer's story, ↑ ↓ asks what else
  // was happening at that moment.
  describe('§6 movement', () => {
    it('walks within the lane on ← →, with no panel needed', () => {
      expect(resolveTimelineKey(key('ArrowLeft'), CTX())).toBe('nav-prev')
      expect(resolveTimelineKey(key('ArrowRight'), CTX())).toBe('nav-next')
    })
    it('changes lane on ↑ ↓', () => {
      expect(resolveTimelineKey(key('ArrowUp'), CTX())).toBe('nav-lane-up')
      expect(resolveTimelineKey(key('ArrowDown'), CTX())).toBe('nav-lane-down')
    })
    it('skips to events carrying state with shift held', () => {
      expect(resolveTimelineKey(key('ArrowLeft', { shiftKey: true }), CTX())).toBe('nav-state-prev')
      expect(resolveTimelineKey(key('ArrowRight', { shiftKey: true }), CTX())).toBe('nav-state-next')
    })
    it('goes to the ends on Home and End', () => {
      expect(resolveTimelineKey(key('Home'), CTX())).toBe('nav-first')
      expect(resolveTimelineKey(key('End'), CTX())).toBe('nav-last')
    })
    it('zooms on + − 0, accepting the unshifted forms', () => {
      // `+` is shift-equals on most layouts; demanding the shift makes a
      // frequent key awkward.
      for (const k of ['+', '=']) expect(resolveTimelineKey(key(k), CTX())).toBe('zoom-in')
      for (const k of ['-', '_']) expect(resolveTimelineKey(key(k), CTX())).toBe('zoom-out')
      expect(resolveTimelineKey(key('0'), CTX())).toBe('zoom-reset')
    })
    it('gives Enter to the Inspector, but only with something selected', () => {
      expect(resolveTimelineKey(key('Enter'), CTX({ hasSelection: true }))).toBe('toggle-detail')
      expect(resolveTimelineKey(key('Enter'), CTX())).toBe('none')
    })
    it('still yields every movement key to a text field', () => {
      for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'End', '+', '0', 'Enter']) {
        expect(resolveTimelineKey(key(k), CTX({ inField: true })), k).toBe('none')
      }
    })
    it('yields to ⌘/Ctrl/Alt so it cannot shadow a system or app chord', () => {
      for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
        expect(resolveTimelineKey(key('ArrowLeft', { [mod]: true }), CTX())).toBe('none')
        expect(resolveTimelineKey(key('0', { [mod]: true }), CTX())).toBe('none')
      }
    })
  })

  describe('Escape peels one layer per press', () => {
    it('drops the selection only after the panel is closed', () => {
      // The ring outlives the Inspector, so the operator does not lose their
      // place just by closing the panel.
      expect(resolveTimelineKey(key('Escape'), CTX({ hasDetail: true, hasSelection: true })))
        .toBe('close-detail')
      expect(resolveTimelineKey(key('Escape'), CTX({ hasSelection: true })))
        .toBe('clear-selection')
      expect(resolveTimelineKey(key('Escape'), CTX())).toBe('none')
    })
  })

  it('ignores unrelated keys', () => {
    expect(resolveTimelineKey(key('a'), CTX({ hasDetail: true }))).toBe('none')
  })
})
