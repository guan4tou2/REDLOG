import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// UIUX-STANDARD §5-6（固定譯名）+ github.md 2026-09-04 的裁決。
//
// 「標記」在這個產品裡是**上鏈、append-only、只能以 `marker.amended` 修訂**
// 的證據。書籤（原 quickmarks，PR #32 / migration F4 起改名 bookmarks）是使用
// 者自己留的瀏覽紀錄：不上鏈、不簽章、可 UPDATE 也可 DELETE、不進證據包。
//
// 改名走過了資料表與側欄，**沒走到那一頁自己的文案**：頁標題印「標記（N）」、
// 搜尋框印「搜尋標記」、編輯鈕印「編輯標記」、匯出提示還印著內部代號
// 「QuickMark」。三個名字指同一件事，其中一個跟鏈上的標記撞名。
//
// 而 `bookmarks.emptyReason` 正好在教使用者這條界線——「要留進紀錄的發現，
// 用〈標記〉」——但那句話只有清單為空時才出現。有第一則書籤之後，使用者看到
// 的每個標籤都在說反話。
//
// emptyReason 是唯一允許提到「標記」的鍵：它的工作就是把兩者對比出來。
const I18N = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n')

function load(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(I18N, `${locale}.json`), 'utf-8'))
}

/** 刻意提到另一個概念以劃清界線的鍵。 */
const CONTRASTS_WITH_MARKERS = new Set(['bookmarks.emptyReason'])

describe('bookmark copy never calls a bookmark a marker', () => {
  for (const [locale, needle] of [['zh-TW', '標記'], ['en', /\bmarks?\b/i]] as const) {
    it(`${locale}: no bookmarks.* string says "marker"`, () => {
      const dict = load(locale)
      const offenders = Object.entries(dict)
        .filter(([k]) => k.startsWith('bookmarks.') && !CONTRASTS_WITH_MARKERS.has(k))
        .filter(([, v]) => (typeof needle === 'string' ? v.includes(needle) : needle.test(v)))
        .map(([k, v]) => `${k} = ${v}`)
      expect(offenders).toEqual([])
    })
  }

  it('the empty state still teaches the distinction', () => {
    // 這條的存在是為了讓上面那條的豁免有意義：豁免的前提是這句話真的在對比。
    expect(load('zh-TW')['bookmarks.emptyReason']).toContain('標記')
    expect(load('zh-TW')['bookmarks.emptyReason']).toContain('不上鏈')
    expect(load('en')['bookmarks.emptyReason']).toMatch(/marker/i)
  })

  it('no internal codename leaks to the operator', () => {
    // `QuickMark` 是改名前的內部名字，出現在匯出提示上超過一個版本。
    for (const locale of ['zh-TW', 'en']) {
      const leaks = Object.entries(load(locale))
        .filter(([, v]) => /quickmark/i.test(v))
        .map(([k, v]) => `${locale} ${k} = ${v}`)
      expect(leaks).toEqual([])
    }
  })

  it('both locales define the same bookmarks.* keys', () => {
    const keys = (l: string) => Object.keys(load(l)).filter((k) => k.startsWith('bookmarks.')).sort()
    expect(keys('en')).toEqual(keys('zh-TW'))
  })
})
