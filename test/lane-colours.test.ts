import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// v0.14.4 (UIUX-STANDARD §1). This file used to assert the opposite: that all
// eighteen lanes had *distinct*, far-apart hues. That property was real and
// tested, and it was the wrong property to have. Eighteen hues on one screen
// left nothing for status to say — `marker`, `scope` and `cleanup` sat in the
// same red family as the red that means "this violated scope" — so hue is now
// reserved for status and lanes separate by label and vertical position.
//
// The invariant is inverted, not deleted: every lane must be the one neutral,
// and the assertions below exist so a future "just give this lane its own
// colour" change has to walk past a red test and read this comment.
//
// The palette is parsed out of the source rather than imported: Timeline.tsx
// pulls in the whole renderer tree (xterm, i18n, the preload bridge), none of
// which a colour assertion needs.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'Timeline.tsx'), 'utf-8'
)
const TAILWIND = fs.readFileSync(path.join(__dirname, '..', 'tailwind.config.js'), 'utf-8')

function laneColour(): string {
  const m = /const LANE_COLOR = '(#[0-9a-fA-F]{6})'/.exec(SRC)
  if (!m) throw new Error('LANE_COLOR not found — did the declaration move?')
  return m[1].toLowerCase()
}

function lanes(): string[] {
  return [...SRC.matchAll(/const LANES = \[([^\]]+)\]/g)][0][1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean)
}

describe('lane palette', () => {
  it('covers every lane exactly once', () => {
    // The table became a generated map, so coverage is structural rather than
    // a count — but assert LANES is still what feeds it.
    expect(SRC).toMatch(/LANES\.map\(\(id\) => \[id, LANE_COLOR\]\)/)
    expect(lanes().length).toBe(18)
    expect(new Set(lanes()).size).toBe(18)
  })

  it('gives every lane the same neutral', () => {
    expect(laneColour()).toBe('#6e6e78')
  })

  it('matches the `lane` token in tailwind.config.js', () => {
    // Two files, one colour: the Timeline draws lane dots inline (SVG fill,
    // not a class) while chips use the Tailwind token. They have to agree.
    const m = /lane: '(#[0-9a-fA-F]{6})'/.exec(TAILWIND)
    expect(m?.[1].toLowerCase()).toBe(laneColour())
  })

  it('is a neutral — no hue for a lane to claim', () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(laneColour().slice(i, i + 2), 16))
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    expect((max - min) / max).toBeLessThan(0.12)
  })

  it('separates from the surfaces it is drawn on', () => {
    // Non-text UI elements need 3:1 (WCAG SC 1.4.11). A lane dot is the only
    // thing marking which row belongs to which lane once hue is gone.
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      const f = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
      const [r, g, b] = c.map(f)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    for (const surface of ['#121214', '#1a1a1d', '#212126']) {
      expect(ratio(laneColour(), surface), `lane on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})
