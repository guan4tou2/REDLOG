import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { QUICK_MARK_ACCELERATOR as MAIN_ACCEL } from '../src/core/shortcuts'
import {
  QUICK_MARK_ACCELERATOR as RENDERER_ACCEL,
  appShortcuts,
  formatAccelerator
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
