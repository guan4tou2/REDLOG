import type { SettingsPage } from '../components/Settings'
import { SETTINGS_SEARCH_KEYS } from './settingsSearchIndex'

export interface SettingsHit {
  key: string
  page: SettingsPage
  /** The rendered text that matched — a group title, a field label or a hint. */
  text: string
}

// Rendered only on macOS (`isMacOS` in the pages), or only elsewhere. The index
// is generated from page sources and so holds both sides of each branch; a hit
// for the other platform's wording leads to a field that page never shows.
const MAC_ONLY = new Set([
  'settings.showWifiNameHint',
  'settings.overlayShowInDock',
  'settings.overlayShowInDockHint',
  'settings.overlayAutoShowHint',
  'settings.overlayPassThroughHint'
])
const NOT_MAC = new Set(['settings.overlayAutoShowHintTray', 'settings.overlayPassThroughHintTray'])

/** Every setting whose rendered text contains `query`, page by page. The box
 *  used to match page names only, so "proxy" or "保留" found nothing unless it
 *  happened to be a page name. */
export function searchSettings(
  query: string,
  t: (key: string) => string,
  limit = 30,
  platform?: string
): SettingsHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SettingsHit[] = []
  const seen = new Set<string>()
  for (const [page, keys] of Object.entries(SETTINGS_SEARCH_KEYS) as Array<[SettingsPage, readonly string[]]>) {
    for (const key of keys) {
      if (platform !== 'win32' && key.startsWith('settings.wsl.')) continue
      if ((platform === 'darwin' ? NOT_MAC : MAC_ONLY).has(key)) continue
      // A template is a runtime state, not a field label. CA has a stable
      // target even before its path is generated; no literal {{path}} leaks.
      if (key === 'httpCapture.caMissing') continue
      const text = key === 'httpCapture.caReady' ? `${t('firstRun.http.caLink')} (CA)` : t(key)
      if (text.includes('{{')) continue
      if (!text || text === key || !text.toLowerCase().includes(q)) continue
      // Short Latin terms such as CA must not match cargo, calendar or localhost.
      if (/^[a-z]{1,3}$/.test(q) && !text.toLowerCase().split(/[^a-z]+/).includes(q)) continue
      const id = `${page}\0${text}`
      if (seen.has(id)) continue
      seen.add(id)
      hits.push({ key, page, text })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
