import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

// Tailwind drops a class it does not recognise. It does not warn, and the
// build does not fail — the element simply renders without that style, which
// on a hover state or a text colour is invisible until someone looks at the
// right pixel in the right state.
//
// Two of these shipped inside an hour of each other while writing the phase 3
// card: `border-redlog-border-strong` (a token that existed before the phase 1
// palette collapsed the border ramp) and `text-wrap-pretty` (the CSS property
// name; Tailwind spells it `text-pretty`). Both looked right in review.

const ROOT = path.join(__dirname, '..')

function redlogTokens(): Set<string> {
  const config = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf-8')
  const block = /redlog: \{([\s\S]*?)\n        \}/.exec(config)
  if (!block) throw new Error('redlog token block not found')
  return new Set([...block[1].matchAll(/'?([a-z][a-z-]*)'?:/g)].map((m) => m[1]))
}

describe('tailwind classes', () => {
  it('only references redlog tokens that exist', () => {
    const tokens = redlogTokens()
    const bad: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
      const src = fs.readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/\b(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide|placeholder|outline|from|to|via|accent|caret|shadow)-redlog-([a-z][a-z-]*)/g)) {
        // Longest-match first: `text-redlog-text-dim` must resolve as
        // `text-dim`, not as `text` with a stray suffix.
        const name = m[1]
        if (tokens.has(name)) continue
        // A trailing opacity or state suffix is not part of the token name.
        const base = name.replace(/-(hover|focus|active|disabled)$/, '')
        if (tokens.has(base)) continue
        bad.push(`${repoRelative(ROOT, file)}: ${m[0]}`)
      }
    }
    expect([...new Set(bad)]).toEqual([])
  })
})
