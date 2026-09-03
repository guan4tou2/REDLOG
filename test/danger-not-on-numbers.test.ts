import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

// UIUX-STANDARD §21 rule 6, the one of the seven CI rule tests the repo did
// not already have: danger red never colours a number.
//
// §1 reserves the danger red for one job — "this is a violation / this will
// destroy something" — and the status table says a state is never carried by
// colour alone. A count, a byte size, a duration or a port rendered in danger
// red reads as an alarm whether or not one is meant, and on a screen an
// operator watches for eight hours that is a false alert that never stops
// ringing. Numbers carry `tabular-nums` (§2), so the two classes co-occurring
// in one className is the exact shape of the mistake, and it can be caught
// from the source the same way lane-colours.test.ts and buttons.test.ts work.

const ROOT = path.join(__dirname, '..')
const DANGER = /(?:text|bg|border)-(?:redlog-danger|red-[45]00|redlog-on-danger)\b/
const NUMERIC = /\btabular-nums\b/
// Every className="…", className={`…`} and className={'…'} literal.
const CLASSNAME = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{'([^']*)'\})/g

function offendersIn(src: string): string[] {
  const hits: string[] = []
  let m: RegExpExecArray | null
  while ((m = CLASSNAME.exec(src)) !== null) {
    const cls = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
    if (DANGER.test(cls) && NUMERIC.test(cls)) hits.push(cls.trim())
  }
  return hits
}

describe('danger red never colours a number (§21 rule 6)', () => {
  it('finds no danger-coloured tabular numerals anywhere in the renderer', () => {
    const files = glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })
    expect(files.length, 'no renderer files found — glob broken?').toBeGreaterThan(20)
    const offenders: string[] = []
    for (const file of files) {
      for (const cls of offendersIn(fs.readFileSync(file, 'utf-8'))) {
        offenders.push(`${repoRelative(ROOT, file)}: "${cls}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('would actually catch the mistake', () => {
    // A guard that cannot bite is decoration. The exact shape §21 forbids.
    const bad = '<span className="text-redlog-danger tabular-nums">{count}</span>'
    expect(offendersIn(bad)).toHaveLength(1)
    // …and the shapes it must leave alone: a danger label with no number, a
    // number with no danger colour.
    expect(offendersIn('<span className="text-redlog-danger">違規</span>')).toEqual([])
    expect(offendersIn('<span className="text-redlog-text tabular-nums">{count}</span>')).toEqual([])
  })
})
