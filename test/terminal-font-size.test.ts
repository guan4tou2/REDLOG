import { describe, expect, it } from 'vitest'
import { clampFontSize, DEFAULT_FONT_SIZE, FONT_MIN, FONT_MAX } from '../src/renderer/src/lib/terminalFont'

// The key bindings step the size by one and the stored value is parsed back
// through the same range. Before this, only the parser had bounds: holding ⌘+
// could persist 33, and the next launch silently reset the operator's choice
// to the default. The range is the contract, so it is what is asserted.
describe('terminal font size bounds', () => {
  it('steps up to the maximum and stops', () => {
    expect(clampFontSize(DEFAULT_FONT_SIZE + 1)).toBe(DEFAULT_FONT_SIZE + 1)
    expect(clampFontSize(FONT_MAX)).toBe(FONT_MAX)
    expect(clampFontSize(FONT_MAX + 1)).toBe(FONT_MAX)
    expect(clampFontSize(FONT_MAX + 100)).toBe(FONT_MAX)
  })

  it('steps down to the minimum and stops', () => {
    expect(clampFontSize(DEFAULT_FONT_SIZE - 1)).toBe(DEFAULT_FONT_SIZE - 1)
    expect(clampFontSize(FONT_MIN)).toBe(FONT_MIN)
    expect(clampFontSize(FONT_MIN - 1)).toBe(FONT_MIN)
    expect(clampFontSize(0)).toBe(FONT_MIN)
  })

  it('rounds a fractional size rather than storing it', () => {
    expect(clampFontSize(12.4)).toBe(12)
    expect(clampFontSize(12.6)).toBe(13)
  })

  it('falls back to the default for a value that is not a number', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE)
  })
})
