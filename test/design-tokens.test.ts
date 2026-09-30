import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Regression tests for docs/UIUX-STANDARD.md §1–§3, in the style of
// lane-colours.test.ts: parse the source, assert the property. Nothing here
// renders anything — these catch the failures a screenshot review misses,
// because a colour that is 0.3:1 short of the floor looks fine until someone
// reads it on a laptop in daylight.

const ROOT = path.join(__dirname, '..')
const INDEX_CSS = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'src', 'styles', 'index.css'), 'utf-8'
)

function redlogTokens(): Record<string, string> {
  const block = /@theme \{([\s\S]*?)\n\}/.exec(INDEX_CSS)
  if (!block) throw new Error('redlog token block not found — did it move?')
  const out: Record<string, string> = {}
  for (const m of block[1].matchAll(/--color-redlog-([a-z][a-z-]*):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2]
  return out
}

const luminance = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const f = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = c.map(f)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('token palette', () => {
  it('defines every role the standard names', () => {
    const t = redlogTokens()
    for (const role of [
      'bg', 'surface', 'elevated', 'border', 'border-subtle',
      'text', 'text-dim', 'text-faint', 'muted',
      'accent', 'danger', 'lane'
    ]) {
      expect(t, `missing role: ${role}`).toHaveProperty(role)
    }
  })

  it('keeps brand red and danger red distinct', () => {
    // They were the same colour, which made "this is RedLog" and "this will
    // destroy something" look alike. §1: accent draws text and hairlines,
    // danger fills.
    const t = redlogTokens()
    expect(t.accent).not.toBe(t.danger)
  })

  it('holds every readable tier above 6:1, hover surface included', () => {
    // 6, not WCAG's 4.5. That threshold is calibrated at ~16px normal weight;
    // the app's floor is 13px and the default zoom is 0.9 (lib/uiScale), so
    // body text lands near 11.7px effective. The ramp passed 4.5 and was still
    // unreadable on the near-black field -- which is what a threshold borrowed
    // from the wrong size buys you. `elevated-hover` is in the list because a
    // row does not get harder to read when the cursor is over it.
    const t = redlogTokens()
    const failures: string[] = []
    for (const tier of ['text', 'text-dim', 'text-faint'] as const) {
      for (const s of ['bg', 'surface', 'elevated', 'elevated-hover'] as const) {
        expect(t[s], `token ${s} not found`).toMatch(/^#[0-9a-f]{6}$/i)
        const ratio = contrast(t[tier], t[s])
        if (ratio < 6) failures.push(`${tier} on ${s}: ${ratio.toFixed(2)}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  it('holds muted above 4.5:1 as well', () => {
    // §1 scopes `muted` to placeholder and disabled text, which WCAG exempts
    // -- so it is held one tier lower than the rest, not exempted outright. It
    // sat at 3.55:1 on the hover surface, which is not "de-emphasised", it is
    // gone. Anything a person must read is `text-faint` or brighter.
    const t = redlogTokens()
    const failures: string[] = []
    for (const s of ['bg', 'surface', 'elevated', 'elevated-hover'] as const) {
      const ratio = contrast(t.muted, t[s])
      if (ratio < 4.5) failures.push(`muted on ${s}: ${ratio.toFixed(2)}:1`)
    }
    expect(failures).toEqual([])
  })

  it('keeps each step of the text ramp visibly apart', () => {
    // Contrast alone does not make a hierarchy: `text-dim` and `text-faint`
    // were 2.7 L* apart, which is at the edge of a just-noticeable difference.
    // Three tokens, two visible tiers, and every "this is secondary" the app
    // tried to say went unheard.
    const t = redlogTokens()
    const lstar = (hex: string): number => 116 * Math.cbrt(luminance(hex)) - 16
    const ramp = ['text', 'text-dim', 'text-faint', 'muted'] as const
    for (let i = 1; i < ramp.length; i++) {
      const gap = lstar(t[ramp[i - 1]]) - lstar(t[ramp[i]])
      expect(gap, `${ramp[i - 1]} -> ${ramp[i]} is only ${gap.toFixed(1)} L* apart`)
        .toBeGreaterThanOrEqual(5)
    }
  })

  it('holds non-text elements above 3:1 on every surface', () => {
    // WCAG SC 1.4.11. `lane` is the only thing marking lane membership now
    // that hue is gone, and `border` carries the app's entire depth model.
    const t = redlogTokens()
    const failures: string[] = []
    for (const role of ['lane', 'danger'] as const) {
      for (const s of ['bg', 'surface', 'elevated'] as const) {
        const ratio = contrast(t[role], t[s])
        if (ratio < 3) failures.push(`${role} on ${s}: ${ratio.toFixed(2)}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  it('orders the text ramp from brightest to dimmest', () => {
    const t = redlogTokens()
    const ramp = ['text', 'text-dim', 'text-faint', 'muted'].map((k) => luminance(t[k]))
    expect(ramp).toEqual([...ramp].sort((a, b) => b - a))
  })
})

describe('type scale', () => {
  it('floors the app at 13px', () => {
    const block = /@theme \{([\s\S]*?)\n\}/.exec(INDEX_CSS)
    expect(block, '@theme block not found').not.toBeNull()
    const sizes = [...block![1].matchAll(/--text-([a-z0-9]+):\s*([0-9.]+)rem/g)]
      .map((m) => parseFloat(m[2]) * 16)
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13)
  })

  it('keeps the root font-size at the browser default', () => {
    // The scale is stated in px-equivalents in the config. Raising the root
    // too would stack the two and inflate every rem-based spacing utility —
    // that combination is what pulled the layout off the 4px grid before.
    expect(INDEX_CSS).toMatch(/html \{\s*font-size: 16px;\s*\}/)
  })
})

describe('density', () => {
  it('defines all four variables in both densities', () => {
    for (const v of ['--row-h', '--pad', '--gap', '--section-gap']) {
      const uses = INDEX_CSS.match(new RegExp(`${v}:`, 'g')) ?? []
      expect(uses.length, `${v} must be set for both densities`).toBe(2)
    }
    expect(INDEX_CSS).toMatch(/:root\[data-density='tight'\]/)
  })

  it('never lets a row fall below the 32px hit-target floor', () => {
    const rows = [...INDEX_CSS.matchAll(/--row-h: (\d+)px/g)].map((m) => parseInt(m[1]))
    expect(rows.length).toBe(2)
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(32)
  })
})

describe('the shell chrome rules', () => {
  it('still makes chrome unselectable and inputs selectable', () => {
    // Explicitly out of scope for the token work, and easy to lose in a
    // rewrite of this file: dragging across the sidebar and watching labels
    // highlight is the loudest tell that an Electron app is a web page.
    expect(INDEX_CSS).toMatch(/body \{\s*\n\s*-webkit-user-select: none;\s*\n\s*user-select: none;\s*\n\}/)
    expect(INDEX_CSS).toMatch(/\[contenteditable='true'\][\s\S]*?user-select: text/)
  })
})
