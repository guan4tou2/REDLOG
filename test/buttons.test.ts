import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

// §4's four levels, and the one hard constraint that came with the §1 ruling.
//
// The original §1 said brand red may only draw text or a hairline. That drew
// the line in the wrong place — it made the strongest control on a screen look
// like the weakest, and an outline button cannot carry "Install the shell
// hook", which is the only way out of the dashboard's main question. The line
// that works is verb versus state: a filled #d75f63 "Create project" reads as
// something you press, a filled #ff4d4f "IP exposed" reads as something being
// reported.
//
// What remains true is the case those two reds really are indistinguishable
// in: side by side, filled, five luminance units apart. That is a destructive
// dialog — which holds Cancel and the destructive verb and never a primary.

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('button levels', () => {
  it('defines all four in one place', () => {
    const mod = read('src/renderer/src/components/Button.tsx')
    for (const level of ['primary', 'secondary', 'quiet', 'danger']) {
      expect(mod, `missing level: ${level}`).toMatch(new RegExp(`\\b${level}:`))
    }
    // Only two of the four fill, and they are the two the standard names.
    expect(mod).toMatch(/primary: 'bg-redlog-accent/)
    expect(mod).toMatch(/danger: 'bg-redlog-danger/)
  })

  it('never puts a filled primary next to a filled danger', () => {
    // The confirm dialog is the only surface that fills a button with danger,
    // so it is the only place the constraint can be broken.
    const dialog = read('src/renderer/src/components/ConfirmDialog.tsx')
    expect(dialog).toMatch(/bg-redlog-danger/)
    expect(dialog, 'a primary fill would sit beside the destructive verb')
      .not.toMatch(/bg-redlog-accent(?![-/])/)
  })

  it('keeps at most one primary per component', () => {
    // §4: at most one primary action per screen. Per file is the closest
    // static stand-in, and it catches the real regression — a second primary
    // added to a view that already had one.
    const offenders: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
      const src = fs.readFileSync(file, 'utf-8')
      if (file.endsWith('Button.tsx')) continue
      const count = (src.match(/level="primary"/g) ?? []).length
      if (count > 1) offenders.push(`${repoRelative(ROOT, file)}: ${count}`)
    }
    expect(offenders).toEqual([])
  })

  it('leaves no hand-rolled primary styling behind', () => {
    // Four call sites carried their own class strings, and two still had dead
    // classes from an earlier revision fighting the ones beside them —
    // `text-white` under a `text-redlog-accent`, a `hover:bg-red-700` under an
    // accent hover. One definition is what stops that recurring.
    const offenders: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
      if (file.endsWith('Button.tsx') || file.endsWith('EmptyState.tsx')) continue
      const src = fs.readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/className="[^"]*bg-redlog-accent(?![-/])[^"]*"/g)) {
        // A 2px active-indicator bar is a hairline, which §1 still allows —
        // the rule is that brand red fills *command buttons* and nothing
        // else. Padding is what distinguishes a control from a line.
        if (!/\bp[xy]?-/.test(m[0])) continue
        offenders.push(`${repoRelative(ROOT, file)}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
