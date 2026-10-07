import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

// `align-items: center` on a scrolling box is a trap, not a style choice.
//
// Once the content is taller than the box, a centred flex child overflows in
// BOTH directions, and the half above the scroll origin cannot be reached by
// scrolling. On the project picker that meant shrinking the window cut the
// wordmark in half with no way to bring it back — the operator's first screen,
// broken by resizing it.
//
// `safe center` is the fix: centred while it fits, flex-start when it does
// not. This test exists because the broken version looks correct in every
// screenshot taken at a comfortable window size.

const ROOT = path.join(__dirname, '..')

const CENTERING = /\b(items-center|place-items-center|place-content-center|content-center)\b/
const SCROLLS = /\b(overflow-y-auto|overflow-auto|overflow-y-scroll)\b/

describe('scrolling containers', () => {
  it('never centre their cross axis unsafely', async () => {
    const files = await glob('src/renderer/src/**/*.tsx', { cwd: ROOT })
    const offenders: string[] = []
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
      text.split('\n').forEach((line, i) => {
        // One className, both properties: that is the combination that breaks.
        const m = /className="([^"]*)"/.exec(line)
        if (!m) return
        if (SCROLLS.test(m[1]) && CENTERING.test(m[1])) offenders.push(`${rel}:${i + 1}  ${m[1]}`)
      })
    }
    expect(offenders, 'use `alignItems: "safe center"` (or start) on a box that scrolls').toEqual([])
  })
})
