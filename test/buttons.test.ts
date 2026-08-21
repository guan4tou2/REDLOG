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

// Every accent in this palette is mid-luminance, so white text fails AA on
// all of them — #d75f63 gives 3.68:1, #ff4d4f 3.27:1, and the emerald and
// cyan are down at 1.9 and 2.0, which is barely text at all. Dark text clears
// 5:1 on every one. The rule is therefore not per-colour and not per-
// component: fill anything, and the text on it goes dark.
describe('text on a fill', () => {
  const luminance = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const f = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
    const [r, g, b] = c.map(f)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  function tokens(): Record<string, string> {
    const config = read('tailwind.config.js')
    const block = /redlog: \{([\s\S]*?)\n        \}/.exec(config)
    if (!block) throw new Error('redlog token block not found')
    const out: Record<string, string> = {}
    for (const m of block[1].matchAll(/'?([a-z][a-z-]*)'?: '(#[0-9a-fA-F]{6})'/g)) out[m[1]] = m[2]
    return out
  }

  it('pairs every fill with a dark that clears 4.5:1', () => {
    const t = tokens()
    const pairs: Array<[string, string]> = [
      ['accent', 'on-accent'],
      ['danger', 'on-danger']
    ]
    for (const [fill, on] of pairs) {
      expect(t[on], `missing token: ${on}`).toBeTruthy()
      const r = ratio(t[on], t[fill])
      expect(r, `${on} on ${fill} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      // And prove the thing being replaced really was failing, so the rule
      // keeps its justification attached.
      expect(ratio('#ffffff', t[fill]), `white on ${fill} should be the bad option`).toBeLessThan(4.5)
    }
  })

  it('leaves no white text on a coloured fill anywhere', () => {
    const offenders: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
      const src = fs.readFileSync(file, 'utf-8')
      if (/text-white/.test(src)) offenders.push(repoRelative(ROOT, file))
    }
    // Not "no white on a fill" but "no white at all": the four remaining uses
    // were plain text on a dark surface, where white was only ever an
    // approximation of `text` (#ececf0) from outside the token namespace.
    expect(offenders).toEqual([])
  })
})
