import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { repoRelative } from './helpers/repo-path'
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
      const rel = repoRelative(ROOT, file)
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

  it('has an exemption list that actually matches the files it scans', () => {
    // The assertion that would have named the Windows failure for what it was.
    // `path.relative` yields backslashes there, so every exemption key missed
    // and four deliberately-exempt elements were reported as violations — with
    // the failure reading "expected [ …(4) ] to deeply equal []", which says
    // nothing about separators.
    const scanned = new Set(
      glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })
        .map((f) => repoRelative(ROOT, f))
    )
    const unmatched = Object.keys(EXEMPT).filter((rel) => !scanned.has(rel))
    expect(unmatched, 'exemption keys that match no scanned file').toEqual([])
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

// §5.4: an empty state has three parts, and the third — a way out — is the
// one that was missing from every one of them. "Screenshots will appear here
// when captured" restates the empty screen the operator is already looking at.
describe('empty states', () => {
  it('every view that can be empty uses the shared three-part component', () => {
    const VIEWS = [
      ['App.tsx', 'screenshots'],
      ['components/LootPanel.tsx', 'loot'],
      ['components/TargetView.tsx', 'targets'],
      ['components/FindingsView.tsx', 'bookmarks'],
      ['components/TranscriptView.tsx', 'transcript']
    ] as const
    const missing = VIEWS.filter(([file]) => {
      const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src', file), 'utf-8')
      return !/<EmptyState\b/.test(src)
    }).map(([file]) => file)
    expect(missing).toEqual([])
  })

  it('gives each one a reason distinct from its title', () => {
    // The failure mode is a `reason` that restates the title in more words.
    // Comparing the strings catches the laziest version of that.
    const en = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n/en.json'), 'utf-8')
    ) as Record<string, string>
    const pairs = Object.keys(en)
      .filter((k) => k.endsWith('.emptyReason'))
      .map((k) => [k.replace('.emptyReason', '.empty'), k])
    expect(pairs.length, 'no empty-state reasons found at all').toBeGreaterThan(2)
    for (const [titleKey, reasonKey] of pairs) {
      expect(en[reasonKey], `${reasonKey} is missing`).toBeTruthy()
      expect(en[reasonKey], `${reasonKey} just restates the title`).not.toBe(en[titleKey])
      // A reason short enough to be a title is not explaining anything.
      expect(en[reasonKey].length, `${reasonKey} is too short to be a reason`).toBeGreaterThan(40)
    }
  })
})
