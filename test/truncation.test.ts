import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'

// §9: "文字截斷一律可 hover 看全文" — anything that truncates has to keep a
// route to the full value. In a desktop app the cheapest one is the native
// `title`, and the failure mode is silent: an IP, a hash or a command that
// ends in an ellipsis with no way to see the rest looks completely fine in
// a screenshot and is useless in front of an operator.

const ROOT = path.join(__dirname, '..')

// Elements allowed to truncate without their own `title`, each because the
// full value is reachable another way. Keeping this list explicit is the
// point — a new entry has to be argued for in a diff.
const EXEMPT: Record<string, string> = {
  'src/renderer/src/components/Sidebar.tsx':
    'the row is a <button> that already carries title="<label> · ⌘N"',
  'src/renderer/src/components/TranscriptView.tsx':
    'the <pre> wraps rather than truncating; the class is redaction blur, and the block expands',
  'src/renderer/src/components/FindingsView.tsx':
    'section heading — "Marks (12)" has no tail to lose'
}

describe('truncated text', () => {
  it('always keeps a route to the full value', () => {
    const offenders: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
      const rel = path.relative(ROOT, file)
      const src = fs.readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/<(\w+)\b((?:[^<>]|\{[^{}]*\})*?)>/gs)) {
        const attrs = m[2]
        if (!/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(attrs)) continue
        if (/\btitle=|\baria-label=/.test(attrs)) continue
        if (rel in EXEMPT) continue
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the exemption list honest', () => {
    // An exemption for a file that no longer truncates anything is dead
    // permission, and dead permission is how the rule erodes.
    const stale = Object.keys(EXEMPT).filter((rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
      return !/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(src)
    })
    expect(stale).toEqual([])
  })
})
