import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// A density class with no `@utility` behind it emits no CSS at all, and
// nothing says so: `pt-pad` shipped as zero top padding on Targets, and
// `pl-pad` / `pr-pad` as a table flush against the sidebar. Tailwind does not
// derive these from `--pad`; each one has to be declared in index.css.
const ROOT = path.join(__dirname, '..', 'src', 'renderer', 'src')
const CSS = readFileSync(path.join(ROOT, 'styles', 'index.css'), 'utf8')
const declared = new Set([...CSS.matchAll(/@utility\s+([\w-]+)/g)].map(m => m[1]))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return sources(full)
    return /\.tsx?$/.test(e.name) ? [full] : []
  })
}

describe('density utilities', () => {
  it('every *-pad / *-gap class used in the renderer is declared', () => {
    const missing: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?<![\w-])((?:p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|space-[xy])-(?:pad|gap))(?![\w-])/g)) {
        if (!declared.has(m[1])) missing.push(`${path.relative(ROOT, file)}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})
