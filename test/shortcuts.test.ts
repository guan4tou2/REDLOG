import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import glob from 'fast-glob'
import {
  QUICK_MARK_ACCELERATOR as MAIN_ACCEL,
  HUD_PASSTHROUGH_ACCELERATOR as MAIN_HUD_ACCEL
} from '../src/core/shortcuts'
import {
  QUICK_MARK_ACCELERATOR as RENDERER_ACCEL,
  HUD_PASSTHROUGH_ACCELERATOR as RENDERER_HUD_ACCEL,
  appShortcuts,
  formatAccelerator,
  timelineShortcuts
} from '../src/renderer/src/lib/shortcuts'
import { DEFAULT_ORDER, NUMBERED_SLOTS, shortcutNumberFor } from '../src/renderer/src/lib/sidebarOrder'
import en from '../src/renderer/src/i18n/en.json'
import zhTW from '../src/renderer/src/i18n/zh-TW.json'

// The real order, not a copy of it. The stale eight-item fixture that used to
// live here omitted `search` and `http_history` entirely, which is how
// `sidebar.http_history` — a key that exists in neither catalogue — reached ⌘K
// and the shortcut panel and rendered as its own key name to the operator.
const SIDEBAR_ORDER = DEFAULT_ORDER.slice(0, NUMBERED_SLOTS)

// The renderer and main bundles share no module graph (ARCHITECTURE.md), so
// the quick-mark accelerator is written down twice on purpose. This test is
// the thing that keeps the copies honest — without it the tray menu can
// advertise one chord while globalShortcut registers another.
describe('shortcut accelerators', () => {
  it('main and renderer agree on the quick-mark accelerator', () => {
    expect(RENDERER_ACCEL).toBe(MAIN_ACCEL)
  })

  it('main and renderer agree on the HUD click-through escape', () => {
    // This one matters more than most: while pass-through is on the HUD cannot
    // be clicked, so a wrong chord in the cheatsheet leaves the operator with
    // no way out that they can find.
    expect(RENDERER_HUD_ACCEL).toBe(MAIN_HUD_ACCEL)
  })

  it('does not let the two global chords collide', () => {
    expect(MAIN_ACCEL).not.toBe(MAIN_HUD_ACCEL)
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
      '⌘K', '⌘F', '⌘.', '⌘⇧M', '⌘⇧⌥↑↓←→', '⌘⇧P', '⌘T', '⌘W', '⌘⇧[ ]'
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
    for (const id of ['app:palette', 'app:findInPage', 'app:hudCorner']) {
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

// Every module that draws a chord asks the same question, and four of the five
// asked it backwards: `platform !== 'win32'` is true on Linux, so a Linux
// operator was shown `⌘` — a key their keyboard does not have — in the sidebar
// tooltips, the status bar, the Timeline and the `?` panel. `shortcuts.ts`
// itself was always correct; the error was in what each caller passed it,
// which is why the table's own tests never saw it.
describe('platform detection', () => {
  it('lives in one module, and asks whether it is a Mac', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../src/renderer/src/lib/platform.ts'), 'utf-8'
    )
    // Comments only, stripped — the module's header quotes the buggy form in
    // order to explain it, and matching that would be matching the prose.
    const code = raw.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(code).toMatch(/platform === 'darwin'/)
    expect(code, 'the inverted form is the bug this module exists to remove')
      .not.toMatch(/platform !== 'win32'/)
  })

  it('is not re-derived anywhere else', () => {
    const offenders = glob.sync('src/renderer/src/**/*.{ts,tsx}', {
      cwd: path.join(__dirname, '..'), absolute: true
    })
      .filter((f) => !f.endsWith('lib/platform.ts'))
      .filter((f) => /redlog\?\.platform\s*[!=]==/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/'))
    // Settings legitimately branches on the OS for OS-specific features
    // (macOS location services, Windows WSL) rather than for a keyboard glyph.
    expect(offenders.filter((f) => !f.endsWith('Settings.tsx'))).toEqual([])
  })
})

describe('every nav label resolves, in both languages', () => {
  // The shortcut table and ⌘K both build their label key from the VIEW ID
  // (`sidebar.${view}`), so a view whose key does not exist renders the key
  // itself — `sidebar.http_history` — into the operator's command palette.
  // i18n-keys.test.ts cannot see it, because the key is built dynamically.
  it('has a catalogue entry for every numbered view', () => {
    const rows = appShortcuts(DEFAULT_ORDER.slice(0, NUMBERED_SLOTS), true)
      .filter((r) => r.scope === 'nav')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(en, `missing in en: ${r.label}`).toHaveProperty(r.label)
      expect(zhTW, `missing in zh-TW: ${r.label}`).toHaveProperty(r.label)
    }
  })

  it('has one for every view in the order, numbered or not — ⌘K lists them all', () => {
    for (const view of DEFAULT_ORDER) {
      const key = `sidebar.${view === 'screenshots' ? 'screens' : view}`
      expect(en, `missing in en: ${key}`).toHaveProperty(key)
      expect(zhTW, `missing in zh-TW: ${key}`).toHaveProperty(key)
    }
  })

  it('keeps chords out of the labels themselves', () => {
    // `sidebar.search` used to read "Search (⌘/)" — a chord baked into a label
    // that every surface then printed its own hint beside.
    for (const view of DEFAULT_ORDER) {
      const key = `sidebar.${view === 'screenshots' ? 'screens' : view}`
      expect((en as Record<string, string>)[key]).not.toMatch(/⌘|Ctrl\+/)
      expect((zhTW as Record<string, string>)[key]).not.toMatch(/⌘|Ctrl\+/)
    }
  })
})

describe('the number a view wears', () => {
  it('comes from the fixed order, not from where it is rendered', () => {
    expect(shortcutNumberFor('dashboard')).toBe(1)
    expect(shortcutNumberFor('targets')).toBe(NUMBERED_SLOTS)
  })

  it('is null for the views past the numbered run', () => {
    // Three rows used to print 9, 10 and 11 — chords that open nothing, next to
    // a Settings row that prints its own 9.
    for (const view of DEFAULT_ORDER.slice(NUMBERED_SLOTS)) {
      expect(shortcutNumberFor(view), `${view} should carry no chord`).toBeNull()
    }
    expect(DEFAULT_ORDER.slice(NUMBERED_SLOTS)).toEqual(['scope', 'loot', 'marks'])
  })
})
