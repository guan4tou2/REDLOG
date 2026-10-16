import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// UIUX-STANDARD §21 source conventions. Numerical token contrast belongs in
// design-tokens.test.ts; lane-colours.test.ts owns lane uniformity.

const ROOT = path.join(__dirname, '..')

function rendererFiles(): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  walk(path.join(ROOT, 'src', 'renderer', 'src'))
  return out
}
const RENDERER = rendererFiles().map((f) => ({ f: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf-8') }))

describe('UIUX §21 · source rules', () => {
  it('no text-white anywhere in the renderer', () => {
    const bad = RENDERER.filter(({ src }) => /\btext-white\b/.test(src)).map((x) => x.f)
    expect(bad).toEqual([])
  })

  it('no sub-13px bracket type outside the HUD (§2 floor)', () => {
    // HUD/overlay has its own 11px floor and is exempt. The regex catches every
    // bracketed size 1–12px, not just 10–12: HttpHistoryPanel shipped `text-[9px]`
    // badges that slipped straight past the old `1[012]` bound (m4). The `text-xs`
    // utility (12px) is the panel's own baseline and out of scope for this rule.
    const bad = RENDERER
      .filter(({ f }) => !/Overlay|hud/i.test(f))
      .filter(({ src }) => /text-\[([1-9]|1[0-2])px\]/.test(src))
      .map((x) => x.f)
    expect(bad).toEqual([])
  })

  it('danger red never colours numeric text (§C numeric exception)', () => {
    // `text-redlog-danger…">3` — a digit right after a danger-red span open.
    const bad = RENDERER
      .filter(({ src }) => /text-redlog-danger[^"']*"[^>]*>\s*\d/.test(src))
      .map((x) => x.f)
    expect(bad).toEqual([])
  })
})
