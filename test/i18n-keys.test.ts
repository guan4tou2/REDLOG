import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { repoRelative } from './helpers/repo-path'
import glob from 'fast-glob'

// A missing translation key does not throw and does not fall back to English —
// `I18nContext.t()` returns the key itself, so the UI renders the literal
// string `common.retry` where a button label belongs. That failure is invisible
// to every other test and to anyone reviewing a diff, and it was already live
// on main: WslPanel's retry button had been rendering its own key.

const ROOT = path.join(__dirname, '..')
const load = (loc: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${loc}.json`), 'utf-8'))

// Only literal `t('some.key')` calls can be checked statically. Dynamic keys
// (`t(\`sidebar.${view}\`)`) are excluded here and covered where they are built
// — appShortcuts' labels, for instance, are checked in shortcuts.test.ts.
//
// One exception is scanned too: a `reasonKey: 'a.b'` literal. Those are keys
// that reach `t()` through a variable, so the scanner below would never see
// them — and a badge whose key is missing renders the key itself to the
// operator, which is the failure this whole file exists to catch.
function usedKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
    const src = fs.readFileSync(file, 'utf-8')
    const patterns = [
      /\bt\(\s*'([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g,
      /\breasonKey:\s*'([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g
    ]
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const rel = repoRelative(ROOT, file)
        out.set(m[1], [...(out.get(m[1]) ?? []), rel])
      }
    }
  }
  return out
}

describe('i18n keys', () => {
  it('resolves every literal key used in a component', () => {
    const en = load('en')
    const missing = [...usedKeys()]
      .filter(([k]) => !(k in en))
      .map(([k, files]) => `${k} (${[...new Set(files)].join(', ')})`)
    expect(missing).toEqual([])
  })

  it('keeps both locales at the same key set', () => {
    const en = Object.keys(load('en'))
    const zh = Object.keys(load('zh-TW'))
    expect([...en].filter((k) => !zh.includes(k)), 'in en, missing from zh-TW').toEqual([])
    expect([...zh].filter((k) => !en.includes(k)), 'in zh-TW, missing from en').toEqual([])
  })

  it('keeps interpolation placeholders identical across locales', () => {
    // `{{port}}` present in one locale and misspelled in the other renders the
    // literal `{{prot}}` to whoever reads that language.
    const en = load('en'), zh = load('zh-TW')
    const vars = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    const mismatched = Object.keys(en)
      .filter((k) => k in zh && vars(en[k]).join() !== vars(zh[k]).join())
      .map((k) => `${k}: en[${vars(en[k])}] vs zh-TW[${vars(zh[k])}]`)
    expect(mismatched).toEqual([])
  })
})
