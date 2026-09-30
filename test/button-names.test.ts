// UI/UX audit F16: a button whose only content is an icon or a single glyph
// ("+", "×", "▸") has no accessible name unless one is given, and a screen
// reader announces it as "button" or "plus". IconButton makes the name
// required; this catches a raw <button> that bypasses it.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

const ROOT = path.join(__dirname, '..')
const GLYPH = /^[×✕✖⨯…⋯▾▸◂▴▲▼←→↑↓+−\-✓✎⟳↻⌫]$/

describe('icon-only buttons', () => {
  it('all carry an accessible name', () => {
    const offenders: string[] = []
    for (const f of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT })) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const m of src.matchAll(/<button\b((?:[^>]|=>)*?)>([\s\S]*?)<\/button>/g)) {
        if (/aria-label/.test(m[1])) continue
        const text = m[2]
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
          .replace(/<[A-Z][\w.]*\b[^>]*\/>/g, '')
          .replace(/\s+/g, '')
        if (text === '' || GLYPH.test(text)) {
          offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
