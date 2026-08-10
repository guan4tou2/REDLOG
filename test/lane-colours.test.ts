import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// v0.11.4 (AUDIT V1/V2). Two properties of the lane palette that regressed
// silently and that no rendering test can see — empty lanes auto-collapse, so
// the DOM never shows all eighteen at once.
//
// The palette is parsed out of the source rather than imported: Timeline.tsx
// pulls in the whole renderer tree (xterm, i18n, the preload bridge), none of
// which a colour assertion needs.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'Timeline.tsx'), 'utf-8'
)

function lanePalette(): Array<[string, string]> {
  const block = /const LANE_COLORS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(SRC)
  if (!block) throw new Error('LANE_COLORS not found — did the declaration move?')
  return [...block[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => [m[1], m[2]])
}

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

const distance = (a: string, b: string): number =>
  Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]))

describe('lane palette', () => {
  it('covers every lane exactly once', () => {
    const lanes = [...SRC.matchAll(/const LANES = \[([^\]]+)\]/g)][0][1]
      .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean)
    const palette = lanePalette()
    expect(palette.length).toBe(lanes.length)
    expect(new Set(palette.map(([k]) => k))).toEqual(new Set(lanes))
  })

  it('gives no two lanes the same colour', () => {
    // `marker` and `scope` were byte-identical (#ef4444) — the two lanes an
    // operator most needs to tell apart at a glance — with `cleanup` a shade
    // away. Nothing in the UI would have shown that.
    const palette = lanePalette()
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [lane, colour] of palette) {
      const prev = seen.get(colour)
      if (prev) clashes.push(`${prev} and ${lane} are both ${colour}`)
      else seen.set(colour, lane)
    }
    expect(clashes).toEqual([])
  })

  it('keeps every pair far enough apart to separate side by side', () => {
    // Not a perceptual model — a crude RGB distance floor that catches "these
    // two are the same shade with one channel nudged", which is how the red
    // family drifted together in the first place.
    const palette = lanePalette()
    const tooClose: string[] = []
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const d = distance(palette[i][1], palette[j][1])
        if (d < 18) tooClose.push(`${palette[i][0]}/${palette[j][0]} (${d.toFixed(0)})`)
      }
    }
    expect(tooClose).toEqual([])
  })

  it('stays inside the desaturated band the rest of the app uses', () => {
    // tailwind.config.js desaturates every accent because high-saturation on
    // near-black vibrates. The lane palette used raw Tailwind values and was
    // the most saturated surface in the app.
    const loud = lanePalette().filter(([, hex]) => {
      const [r, g, b] = rgb(hex)
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      return max > 0 && (max - min) / max > 0.72
    })
    expect(loud.map(([lane, hex]) => `${lane}=${hex}`)).toEqual([])
  })
})
