// UI/UX audit F18: the zh-TW strings drifted from the fixed glossary
// (docs/UIUX-STANDARD.md §5.6), and hints named settings pages that had been
// renamed ("設定 ▸ 資料", a page that no longer exists). Both are cheap to
// check and easy to reintroduce.
import { describe, expect, it } from 'vitest'
import zh from '../src/renderer/src/i18n/zh-TW.json'
import en from '../src/renderer/src/i18n/en.json'

const zhMap = zh as Record<string, string>
const enMap = en as Record<string, string>

describe('zh-TW terminology', () => {
  it('uses the fixed translations, not the English nouns', () => {
    const fixed = /\b(Loot|Scope|Marker|Pivot|Transcript|Anchor|Chain|Timeline|Inspector)\b/
    const offenders = Object.entries(zhMap).filter(([, v]) => fixed.test(v)).map(([k]) => k)
    expect(offenders).toEqual([])
  })

  it('names only settings pages that exist', () => {
    const pages = new Set(Object.entries(zhMap).filter(([k]) => k.startsWith('settings.page')).map(([, v]) => v))
    const pagesEn = new Set(Object.entries(enMap).filter(([k]) => k.startsWith('settings.page')).map(([, v]) => v))
    const bad: string[] = []
    // Prefix, not exact match. A page name can contain the characters the
    // capture stops at — 「擷取 pack、截圖與保留」 ends a Chinese clause with 、,
    // and "Packs, screenshots & retention" has a comma in it — so demanding
    // equality flagged correct references and would have pushed the next
    // person into rewording a true sentence to satisfy the test.
    const names = (set: Set<string>, captured: string): boolean =>
      [...set].some((n) => captured.startsWith(n))
    for (const [k, v] of Object.entries(zhMap)) {
      for (const m of v.matchAll(/設定\s*[▸→]\s*([^」。)）]+)/g)) {
        const name = m[1].trim()
        if (!name.startsWith('{{page}}') && !names(pages, name)) bad.push(`${k}: ${name}`)
      }
    }
    for (const [k, v] of Object.entries(enMap)) {
      for (const m of v.matchAll(/Settings\s*[▸→]\s*([^.;)]+)/g)) {
        const name = m[1].trim()
        if (!name.startsWith('{{page}}') && !names(pagesEn, name)) bad.push(`${k}: ${name}`)
      }
    }
    expect(bad).toEqual([])
  })
})
