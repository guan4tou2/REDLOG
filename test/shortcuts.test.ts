import { describe, it, expect } from 'vitest'
import { SHORTCUTS, shortcutsForScope, modKey, type Shortcut } from '../src/renderer/src/lib/shortcuts'

describe('shortcuts registry', () => {
  it('every entry has id/keys/labelKey/scope', () => {
    for (const s of SHORTCUTS) {
      expect(typeof s.id).toBe('string')
      expect(s.id.length).toBeGreaterThan(0)
      expect(typeof s.keys).toBe('string')
      expect(s.keys.length).toBeGreaterThan(0)
      expect(typeof s.labelKey).toBe('string')
      expect(s.labelKey.length).toBeGreaterThan(0)
      expect(['global', 'timeline']).toContain(s.scope)
    }
  })

  it('has no duplicate ids', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers the real global + timeline shortcuts', () => {
    const byId = (id: string): Shortcut | undefined => SHORTCUTS.find((s) => s.id === id)
    // global
    expect(byId('switch-view')?.scope).toBe('global')
    expect(byId('quick-marker')?.scope).toBe('global')
    expect(byId('search')?.scope).toBe('global')
    expect(byId('pause-recording')?.scope).toBe('global')
    // timeline
    expect(byId('filter-events')?.scope).toBe('timeline')
    expect(byId('toggle-help')?.scope).toBe('timeline')
    expect(byId('focus-chain')?.scope).toBe('timeline')
    expect(byId('command-palette')?.scope).toBe('timeline')
    expect(byId('navigate-events')?.scope).toBe('timeline')
    expect(byId('solo-lane')?.scope).toBe('timeline')
    expect(byId('drop-marker')?.scope).toBe('timeline')
  })

  it('uses the literal Mod placeholder token, never a resolved symbol', () => {
    for (const s of SHORTCUTS) {
      expect(s.keys).not.toContain('⌘')
      expect(s.keys).not.toContain('Ctrl')
    }
    expect(byKeys('switch-view')).toBe('Mod+1..9')
    expect(byKeys('quick-marker')).toBe('Mod+Shift+M')
    expect(byKeys('search')).toBe('Mod+/')
    expect(byKeys('pause-recording')).toBe('Mod+.')
    expect(byKeys('command-palette')).toBe('Mod+K')
    expect(byKeys('filter-events')).toBe('/')
    expect(byKeys('toggle-help')).toBe('?')
    expect(byKeys('focus-chain')).toBe('f')
    expect(byKeys('navigate-events')).toBe('↑/↓')
    expect(byKeys('solo-lane')).toBe('Alt+click')
    expect(byKeys('drop-marker')).toBe('Right-click')
  })

  function byKeys(id: string): string | undefined {
    return SHORTCUTS.find((s) => s.id === id)?.keys
  }
})

describe('shortcutsForScope', () => {
  it("'global' returns only global-scope shortcuts", () => {
    const list = shortcutsForScope('global')
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((s) => s.scope === 'global')).toBe(true)
    // no timeline-scope entry leaks in
    expect(list.some((s) => s.scope === 'timeline')).toBe(false)
  })

  it("'timeline' returns global + timeline shortcuts", () => {
    const list = shortcutsForScope('timeline')
    expect(list.some((s) => s.scope === 'global')).toBe(true)
    expect(list.some((s) => s.scope === 'timeline')).toBe(true)
    // it is a superset of the global scope
    expect(list.length).toBe(shortcutsForScope('global').length + SHORTCUTS.filter((s) => s.scope === 'timeline').length)
  })
})

describe('modKey', () => {
  it("returns ⌘ on darwin", () => {
    expect(modKey('darwin')).toBe('⌘')
  })

  it('returns Ctrl on every other platform', () => {
    expect(modKey('win32')).toBe('Ctrl')
    expect(modKey('linux')).toBe('Ctrl')
    expect(modKey('')).toBe('Ctrl')
  })
})
