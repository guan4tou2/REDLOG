// Folding is a VIEW. It must never reach the record.
//
// A fold asserts that 920 requests came from one command. That assertion is
// safe on screen, where it is drawn from `_causes` and labelled with its
// basis and can be expanded — and it is not safe in an exported file, where
// it would arrive as structure a reader cannot question and a verifier cannot
// check. The hash chain covers events; it does not cover groupings, so
// `tools/redlog-verify.py` has nothing to say about a layer like this.
//
// The rule is therefore structural rather than behavioural: the fold module
// lives in the renderer and nothing in core, main or preload may import it.
// A behavioural test would pass right up until someone added one import.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', 'src')

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const importers = (needle: string, dirs: string[]): string[] =>
  dirs
    .flatMap((d) => sourcesUnder(join(ROOT, d)))
    .filter((f) => new RegExp(`from ['"][^'"]*${needle}['"]`).test(readFileSync(f, 'utf-8')))
    .map((f) => f.slice(ROOT.length + 1))

describe('folding cannot reach the record', () => {
  it('is not imported by core, main or preload', () => {
    expect(importers('timelineFold', ['core', 'main', 'preload'])).toEqual([])
  })

  it('is not imported by the export paths in the renderer either', () => {
    // ExportMenu builds the request; nothing it sends may carry a grouping.
    const exportFiles = sourcesUnder(join(ROOT, 'renderer'))
      .filter((f) => /Export/i.test(f))
      .filter((f) => /from ['"][^'"]*timelineFold['"]/.test(readFileSync(f, 'utf-8')))
    expect(exportFiles).toEqual([])
  })

  it('the export request shape has no field a grouping could ride in', () => {
    // If one is ever added, this test is where the argument has to happen.
    const plan = readFileSync(join(ROOT, 'core', 'export-plan.ts'), 'utf-8')
    const request = /export interface ExportRequest \{([\s\S]*?)\n\}/.exec(plan)?.[1] ?? ''
    expect(request.length).toBeGreaterThan(0)
    for (const word of ['fold', 'group', 'collapse', 'parent', 'children']) {
      expect(request.toLowerCase(), `ExportRequest gained a "${word}" field`).not.toContain(word)
    }
  })
})

describe('the causal rule is enforced where it is written, not in the view', () => {
  it('the fold module reads only `_causes`', () => {
    // The whole safety of this feature. A User-Agent compare, a time window
    // or a host match here would turn a recorded fact into a guess, in a
    // collapsed row a reader may never open.
    const src = readFileSync(join(ROOT, 'renderer', 'src', 'lib', 'timelineFold.ts'), 'utf-8')
    expect(src).toContain('_causes')
    for (const guess of ['user_agent', 'userAgent', 'timestamp -', 'host ===', 'WINDOW_MS', 'GAP_MS']) {
      expect(src, `timelineFold started inferring with ${guess}`).not.toContain(guess)
    }
  })

  it('does not reuse groupFlows, which falls back to an idle gap', () => {
    // httpActivity's grouping is right for the HTTP page and wrong here: it
    // groups uncaused traffic by host and a 4s gap, which is precisely the
    // inference a fold must not make.
    const src = readFileSync(join(ROOT, 'renderer', 'src', 'lib', 'timelineFold.ts'), 'utf-8')
    expect(src).not.toContain('groupFlows')
    expect(src).not.toContain('httpActivity')
  })
})
