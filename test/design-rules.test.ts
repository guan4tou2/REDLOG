import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// UIUX-STANDARD §21: the token/contrast rules, parsed from source so a reviewer
// checks "test exists and is green", not "I eyeballed it". Companion to
// lane-colours.test.ts (which owns the lane-uniformity rule). Tokens are read
// out of tailwind.config.js rather than imported — a colour assertion shouldn't
// pull in PostCSS.

const ROOT = path.join(__dirname, '..')
const TW = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf-8')

/** WCAG relative luminance + contrast ratio. */
function lum(hex: string): number {
  const c = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
  const lin = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
function contrast(a: string, b: string): number {
  const la = lum(a), lb = lum(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** A named `redlog` token's hex, e.g. tok('text-dim') / tok('on-accent'). */
function tok(name: string): string {
  // The leading [\s{,'"] stops `accent` from matching inside `on-accent`
  // (a '-' before the name is not a key boundary).
  const re = new RegExp(`[\\s{,'"]${name.replace(/-/g, '\\-')}['"]?\\s*:\\s*'(#[0-9a-fA-F]{6})'`)
  const m = re.exec(TW)
  if (!m) throw new Error(`token '${name}' not found in tailwind.config.js`)
  return m[1].toLowerCase()
}
/** The amber-400 fill (#d4ac5a) that `on-warn` sits on. */
function amber400(): string {
  const m = /amber:\s*\{[^}]*?400:\s*'(#[0-9a-fA-F]{6})'/.exec(TW)
  if (!m) throw new Error('amber-400 not found')
  return m[1].toLowerCase()
}

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

// Fills that carry text, each paired with its `on-*` token (§4: every solid
// colour uses a dark on-colour; amber is the `warn` fill).
const FILLS: Array<[string, string]> = [
  [tok('accent'), tok('on-accent')],
  [tok('danger'), tok('on-danger')],
  [amber400(), tok('on-warn')]
]

describe('UIUX §21 · token contrast', () => {
  it('secondary text clears 4.5:1 on the window ground', () => {
    expect(contrast(tok('text-dim'), tok('bg'))).toBeGreaterThanOrEqual(4.5)
  })

  it('every fill has an on-colour that clears 4.5:1', () => {
    for (const [fill, on] of FILLS) {
      expect(contrast(on, fill), `on-colour ${on} on fill ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('white on any fill fails AA — the reason the on-colours are dark', () => {
    for (const [fill] of FILLS) {
      expect(contrast('#ffffff', fill), `white on ${fill}`).toBeLessThan(4.5)
    }
  })

  it('brand accent and danger are genuinely different colours (§1)', () => {
    expect(tok('accent')).not.toBe(tok('danger'))
  })
})

describe('UIUX §21 · source rules', () => {
  it('no text-white anywhere in the renderer', () => {
    const bad = RENDERER.filter(({ src }) => /\btext-white\b/.test(src)).map((x) => x.f)
    expect(bad).toEqual([])
  })

  it('no sub-13px type outside the HUD (§2 floor)', () => {
    // HUD/overlay has its own 11px floor and is exempt.
    const bad = RENDERER
      .filter(({ f }) => !/Overlay|hud/i.test(f))
      .filter(({ src }) => /text-\[1[012]px\]/.test(src))
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
