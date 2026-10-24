import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../src/core/config'
import { isMemberSelected } from '../src/core/capture-packs'

// Spec 060 US4.2: first-time setup asks for nothing beyond commands and web
// traffic. Every optional capture starts off, and the clipboard stays off even
// inside a pack that is on. A regression guard, not a feature.
describe('advanced capture sources default to off', () => {
  it('has every capture pack off', () => {
    expect(DEFAULT_CONFIG.packs).toEqual({ hostMonitors: false, windowsOutput: false })
  })

  it('never collects the clipboard because a pack was turned on', () => {
    expect(isMemberSelected(undefined, 'clipboard')).toBe(false)
    expect(isMemberSelected({}, 'clipboard')).toBe(false)
  })

  it('does not store clipboard previews by default', () => {
    expect(DEFAULT_CONFIG.clipboard?.storePreview).toBe(false)
  })
})
