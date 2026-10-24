// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { resolveDensity, applyDensity, AUTO_TIGHT_SCALE } from '../src/renderer/src/lib/density'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// docs/UIUX-STANDARD.md §3 declares four density variables and says tight
// changes row heights AND padding. Only `--row-h` was ever read: `--pad`,
// `--gap` and `--section-gap` were declared in styles/index.css and referenced
// by nothing, so switching to tight shrank the sidebar rows and left every
// card, panel and gap exactly where it was — while density.ts's own comment
// claimed the padding moved.

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/index.css'), 'utf8')

describe('density', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-density') })

  it('resolves an explicit choice over the automatic one', () => {
    expect(resolveDensity(1, 'comfortable')).toBe('comfortable')
    expect(resolveDensity(2, 'comfortable')).toBe('comfortable')
    expect(resolveDensity(1, 'tight')).toBe('tight')
  })

  it('goes tight on its own once the scale is large enough', () => {
    expect(resolveDensity(AUTO_TIGHT_SCALE, null)).toBe('tight')
    expect(resolveDensity(AUTO_TIGHT_SCALE - 0.01, null)).toBe('comfortable')
  })

  it('reflects the choice onto the document, and removes it for comfortable', () => {
    applyDensity('tight')
    expect(document.documentElement.getAttribute('data-density')).toBe('tight')
    applyDensity('comfortable')
    expect(document.documentElement.hasAttribute('data-density')).toBe(false)
  })

  // The regression this file exists for: the variables were declared and never
  // consumed, so the feature was a no-op that looked implemented.
  it('binds the padding and gap variables to utilities that are actually used', () => {
    // Declared, and overridden for tight.
    for (const v of ['--pad', '--gap', '--section-gap', '--row-h']) {
      expect(CSS, `${v} must be declared`).toContain(`${v}:`)
    }
    expect(CSS).toMatch(/:root\[data-density='tight'\]\s*\{[^}]*--pad:\s*10px/)
    // Consumed. A variable nothing reads is a comment.
    //
    // `p-pad` and `gap-gap` are `@utility` declarations — Tailwind's directive,
    // not a plain `.p-pad` rule — because only a declared utility survives the
    // scan; a hand-written class would be emitted but never recognised as one.
    // `space-y-section` is a plain rule: Tailwind rejects `>` in a utility name.
    expect(CSS, 'p-pad must read --pad').toMatch(/@utility p-pad\s*\{\s*padding:\s*var\(--pad\)/)
    expect(CSS, 'gap-gap must read --gap').toMatch(/@utility gap-gap\s*\{\s*gap:\s*var\(--gap\)/)
    expect(CSS, 'space-y-section must read --section-gap')
      .toMatch(/\.space-y-section[^{]*\{[^}]*var\(--section-gap\)/)
  })

  it('uses the density utilities on the page containers, not a fixed p-4', () => {
    // A container that hard-codes its padding ignores the density switch. The
    // nine page-level scrollers are the ones an operator sees change.
    const pages = [
      'components/Settings.tsx',
      'components/ScreenshotsView.tsx',
      'components/ScopeStatus.tsx',
      'components/LootPanel.tsx',
      'components/TargetView.tsx',
      'components/DashboardView.tsx',
      'components/BookmarksView.tsx',
      'components/FirstRunView.tsx'
    ]
    const offenders: string[] = []
    for (const rel of pages) {
      const src = readFileSync(join(__dirname, '..', 'src/renderer/src', rel), 'utf8')
      if (!src.includes('p-pad')) offenders.push(`${rel}: no p-pad`)
    }
    expect(offenders).toEqual([])
  })
})
