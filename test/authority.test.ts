// The §3 authority primitive (K1 minimal slice). Everything downstream — the
// dashed timeline dot, the deconfliction authority floor, the labelling in an
// exported bundle — reads whatever this resolves, so a wrong answer here is a
// wrong answer everywhere at once.

import { describe, it, expect } from 'vitest'
import { authorityOf, isInferred } from '../src/core/authority'

describe('authorityOf — precedence', () => {
  it('a per-event label wins over everything', () => {
    // scope_violation is the case that forces this: it is `fact` for an
    // excluded target and `inferred` for a proximity match, so no type-level
    // answer can be right for both.
    expect(authorityOf({ agentType: 'system', data: { authority: 'inferred' } })).toBe('inferred')
    expect(authorityOf({ agentType: 'loot', data: { authority: 'fact' } })).toBe('fact')
  })

  it('a registered type is consulted next', () => {
    const registered = (t: string): 'inferred' | undefined => (t === 'vendor_guess' ? 'inferred' : undefined)
    expect(authorityOf({ agentType: 'vendor_guess', data: {} }, registered)).toBe('inferred')
    expect(authorityOf({ agentType: 'shell', data: {} }, registered)).toBe('fact')
  })

  it('a per-event label still beats the registration', () => {
    const registered = (): 'inferred' => 'inferred'
    expect(authorityOf({ agentType: 'anything', data: { authority: 'fact' } }, registered)).toBe('fact')
  })

  it('falls back to the built-in table for detector-derived origins', () => {
    for (const agentType of ['loot', 'pivot', 'cleanup', 'file_transfer']) {
      expect(authorityOf({ agentType, data: {} })).toBe('inferred')
    }
  })

  // Primary capture dominates the stream; defaulting to `inferred` would dash
  // nearly everything and drain the distinction of meaning.
  it('everything else is a fact', () => {
    for (const agentType of ['shell', 'marker', 'agent', 'http', 'screenshot', 'system', 'unheard_of']) {
      expect(authorityOf({ agentType, data: {} })).toBe('fact')
    }
  })

  it('handles a missing agentType and missing data', () => {
    expect(authorityOf({})).toBe('fact')
    expect(authorityOf({ agentType: 'loot' })).toBe('inferred')
    expect(authorityOf({ agentType: 'loot', data: null })).toBe('inferred')
  })

  it('ignores a junk authority value rather than trusting it', () => {
    expect(authorityOf({ agentType: 'shell', data: { authority: 'probably' } })).toBe('fact')
    expect(authorityOf({ agentType: 'loot', data: { authority: 42 } })).toBe('inferred')
  })

  it('isInferred is the renderer-facing shorthand', () => {
    expect(isInferred({ agentType: 'loot', data: {} })).toBe(true)
    expect(isInferred({ agentType: 'shell', data: {} })).toBe(false)
  })
})
