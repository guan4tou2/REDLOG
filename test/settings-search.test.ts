import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { searchSettings } from '../src/renderer/src/lib/settingsSearch'
import { SETTINGS_SEARCH_KEYS } from '../src/renderer/src/lib/settingsSearchIndex'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'
// @ts-expect-error — plain ESM helper shared with the generator script
import { PAGE_SOURCES, pageKeys } from '../scripts/settings-search-sources.mjs'

// Settings search finds settings, not only page names (the box matched page
// labels alone, so a search for a field found nothing).
const tr = (dict: Record<string, string>) => (k: string): string => dict[k] ?? k
const read = (f: string): string =>
  fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components', f), 'utf8')

describe('settings search', () => {
  it('has an index entry for every key each page renders — regenerate with npm run gen:settings-search', () => {
    for (const page of Object.keys(PAGE_SOURCES)) {
      expect({ page, keys: SETTINGS_SEARCH_KEYS[page as keyof typeof SETTINGS_SEARCH_KEYS] })
        .toEqual({ page, keys: pageKeys(page, read) })
    }
  })

  it('finds a field by words in its label, on the page that holds it', () => {
    const hits = searchSettings('loot', tr(en))
    expect(hits.some((h) => h.page === 'captureControl')).toBe(true)
  })

  it('searches the displayed language', () => {
    const hits = searchSettings('戰利品', tr(zh))
    expect(hits.some((h) => h.page === 'captureControl' && h.text.includes('戰利品'))).toBe(true)
    expect(searchSettings('保存', tr(zh)).some((h) => h.page === 'captureControl')).toBe(true)
  })

  it('returns nothing for an empty query, and nothing for a key with no translation', () => {
    expect(searchSettings('  ', tr(en))).toEqual([])
    expect(searchSettings('settings.', (k) => k)).toEqual([])
  })
})
