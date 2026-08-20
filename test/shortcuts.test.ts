import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { QUICK_MARK_ACCELERATOR as MAIN_ACCEL } from '../src/core/shortcuts'
import {
  QUICK_MARK_ACCELERATOR as RENDERER_ACCEL,
  appShortcuts,
  formatAccelerator,
  timelineShortcuts
} from '../src/renderer/src/lib/shortcuts'

const SIDEBAR_ORDER = [
  'dashboard', 'timeline', 'transcript', 'terminal', 'screenshots', 'targets', 'scope', 'loot'
]

// The renderer and main bundles share no module graph (ARCHITECTURE.md), so
// the quick-mark accelerator is written down twice on purpose. This test is
// the thing that keeps the copies honest — without it the tray menu can
// advertise one chord while globalShortcut registers another.
describe('shortcut accelerators', () => {
  it('main and renderer agree on the quick-mark accelerator', () => {
    expect(RENDERER_ACCEL).toBe(MAIN_ACCEL)
  })

  it('draws accelerators the way each platform writes them', () => {
    expect(formatAccelerator('CommandOrControl+Shift+M', true)).toBe('⌘⇧M')
    expect(formatAccelerator('CommandOrControl+Shift+M', false)).toBe('Ctrl+Shift+M')
  })
})

describe('the cheatsheet table', () => {
  it('covers every navigable view plus Settings', () => {
    const rows = appShortcuts(SIDEBAR_ORDER, true)
    const nav = rows.filter((r) => r.scope === 'nav')
    expect(nav).toHaveLength(SIDEBAR_ORDER.length + 1)
    expect(nav.map((r) => r.keys)).toEqual(['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘8', '⌘9'])
    expect(nav.at(-1)?.label).toBe('sidebar.settings')
  })

  it('follows a reordered sidebar', () => {
    const rows = appShortcuts(['timeline', 'dashboard'], true)
    expect(rows[0]).toMatchObject({ keys: '⌘1', label: 'sidebar.timeline' })
    expect(rows[1]).toMatchObject({ keys: '⌘2', label: 'sidebar.dashboard' })
  })

  it('quotes the same quick-mark chord the main process registers', () => {
    const row = appShortcuts(SIDEBAR_ORDER, true).find((r) => r.label === 'dashboard.addMarker')
    expect(row?.keys).toBe(formatAccelerator(MAIN_ACCEL, true))
  })

  it('labels resolve in every locale', () => {
    const rows = appShortcuts(SIDEBAR_ORDER, false)
    for (const locale of ['en', 'zh-TW']) {
      const dict = JSON.parse(
        fs.readFileSync(path.join(__dirname, `../src/renderer/src/i18n/${locale}.json`), 'utf-8')
      ) as Record<string, string>
      const missing = rows.map((r) => r.label).filter((k) => !(k in dict))
      expect(missing, `${locale} is missing shortcut labels`).toEqual([])
    }
  })

  // Every shortcut the app binds is supposed to appear here — the list drifted
  // once already, silently hiding ⌘K, ⌘. , the HUD corner chord and the
  // Terminal's tab bindings. Pin the non-nav rows so adding a binding without
  // a row (or vice versa) has to be a deliberate edit to this test.
  it('documents the app- and terminal-scoped bindings', () => {
    const rows = appShortcuts(SIDEBAR_ORDER, true).filter((r) => r.scope !== 'nav')
    expect(rows.map((r) => r.keys)).toEqual([
      '⌘/', '⌘K', '⌘.', '⌘⇧M', '⌘⇧⌥↑↓←→', '⌘T', '⌘W', '⌘⇧[ ]'
    ])
  })
})


describe('the table drives the handler, not just the cheatsheet', () => {
  const rows = appShortcuts(SIDEBAR_ORDER, true)
  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent => init as KeyboardEvent
  const fire = (init: Partial<KeyboardEvent>): string[] =>
    rows.filter((r) => r.match?.(ev(init))).map((r) => r.id)

  it('matches exactly one shortcut per keystroke', () => {
    // Two rows claiming the same chord is how a shortcut becomes
    // order-dependent and then mysteriously stops working.
    for (const e of [
      { key: '1', metaKey: true },
      { key: '9', metaKey: true },
      { key: 'k', metaKey: true },
      { key: '/', metaKey: true },
      { key: '.', metaKey: true },
      { key: 'ArrowUp', metaKey: true, altKey: true, shiftKey: true }
    ]) {
      expect(fire(e), JSON.stringify(e)).toHaveLength(1)
    }
  })

  it('does not fire a bare number, or a number with extra modifiers', () => {
    expect(fire({ key: '1' })).toEqual([])
    expect(fire({ key: '1', metaKey: true, shiftKey: true })).toEqual([])
    expect(fire({ key: '1', metaKey: true, altKey: true })).toEqual([])
  })

  it('routes the numbers through the live sidebar order', () => {
    const reordered = appShortcuts(['timeline', 'dashboard'], true)
    expect(reordered.find((r) => r.match?.(ev({ key: '1', metaKey: true })))?.id)
      .toBe('nav:timeline')
  })

  it('never lets a focused text field swallow view navigation', () => {
    // xterm keeps a hidden textarea focused for as long as the Terminal view
    // is mounted, so a blanket typing guard disables every shortcut there.
    // e2e/project-flow.spec.ts caught exactly this.
    for (const r of rows.filter((x) => x.scope === 'nav')) {
      expect(r.guardTyping, r.id).toBeFalsy()
    }
    // The ones a field may reasonably want do yield.
    for (const id of ['app:search', 'app:palette', 'app:hudCorner']) {
      expect(rows.find((r) => r.id === id)?.guardTyping, id).toBe(true)
    }
  })

  it('leaves the globally-registered marker chord unmatched', () => {
    // The main process owns ⌘⇧M, so the renderer never sees it. The row is
    // documentation, and the absent matcher says so.
    expect(rows.find((r) => r.id === 'app:addMarker')?.match).toBeUndefined()
  })

  it('gives the timeline panel every group with at least one row', () => {
    const groups = timelineShortcuts(true)
    expect(groups.length).toBeGreaterThanOrEqual(5)
    for (const g of groups) {
      expect(g.rows.length, g.label).toBeGreaterThan(0)
      expect(g.label).toMatch(/^timeline\.help\.group\./)
    }
  })

  it('writes the modifier the platform uses, in both tables', () => {
    expect(appShortcuts(SIDEBAR_ORDER, false).find((r) => r.id === 'app:palette')?.keys).toBe('Ctrl+K')
    expect(timelineShortcuts(false)[0].rows[1].keys).toBe('Ctrl+K')
  })
})
