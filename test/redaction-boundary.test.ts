import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

// §10 deletes display-time masking and keeps export-time redaction, and the
// whole value of that decision rests on the two being separate systems. This
// test states the boundary so a future "let's reuse the mask helper" cannot
// quietly move redaction back into the renderer, where it protects nothing and
// can be bypassed by reading the DOM.

const ROOT = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('the redaction boundary', () => {
  it('has no display-time masking left in the renderer', () => {
    // The data is already on the operator's own machine. Masking it there cost
    // a step, protected nothing, and made a copied JSON silently incomplete
    // depending on whether the operator had remembered to hit Reveal.
    const offenders = glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT })
      .filter((f) => /\bmaskEventData\b|\bmaskText\b|\bfieldsWithRedactions\b/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('still redacts on every path out of the app', () => {
    // Bundle export, cloud share and the API's pre-delivery sanitize are
    // layer 4 and live in src/core, reachable without the renderer at all.
    expect(read('src/core/bundle-export.ts')).toMatch(/redact/i)
    expect(read('src/core/api-server.ts')).toMatch(/from '\.\/redaction'/)
  })

  it('keeps the renderer out of the redaction engine', () => {
    // The two bundles share no module graph, so this cannot regress by import
    // — but it can regress by someone copying the rules across, which is the
    // same failure with extra steps.
    const rendererFiles = glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT })
    const importsCore = rendererFiles.filter((f) => /from '.*core\/redaction'/.test(read(f)))
    expect(importsCore).toEqual([])
  })
})
