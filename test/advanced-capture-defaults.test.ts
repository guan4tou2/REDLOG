import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../src/core/config'

// Spec 060 US4.2: first-time setup asks for nothing beyond commands and web
// traffic. Every optional capture starts off. A regression guard, not a feature.
describe('advanced capture sources default to off', () => {
  it('has every capture pack off', () => {
    expect(DEFAULT_CONFIG.packs).toEqual({ hostMonitors: false, windowsOutput: false })
  })
})
