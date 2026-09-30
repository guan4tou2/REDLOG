// Which source files make up each Settings page, for the field-search index
// (src/renderer/src/lib/settingsSearchIndex.ts) and the test that keeps that
// index in step with the pages. `after` takes the file from that marker on;
// `before` up to it — AgentsPanel.tsx holds two panels shown on two pages.
export const PAGE_SOURCES = {
  hooks: [
    { file: 'settings/HooksPanel.tsx' },
    { file: 'settings/ManualStepList.tsx' },
    { file: 'WslPanel.tsx' },
    { file: 'settings/AgentsPanel.tsx', after: 'export function HookWatchPathsPanel' }
  ],
  agents: [{ file: 'settings/AgentsPanel.tsx', before: 'export function HookWatchPathsPanel' }],
  captureControl: [
    { file: 'settings/CaptureControlPage.tsx' },
    { file: 'settings/LootRulesGroup.tsx' },
    { file: 'settings/ExternalCaptureGroup.tsx' }
  ],
  browser: [{ file: 'settings/BrowserPage.tsx' }, { file: 'settings/BrowserPanel.tsx' }],
  scope: [{ file: 'settings/ScopePage.tsx' }],
  network: [{ file: 'settings/NetworkPage.tsx' }],
  integrity: [{ file: 'settings/IntegrityPanel.tsx' }],
  plugins: [{ file: 'settings/PluginsPanel.tsx' }],
  general: [{ file: 'settings/GeneralPage.tsx' }],
  hud: [{ file: 'settings/HudPage.tsx' }],
  about: [{ file: 'settings/AboutPage.tsx' }]
}

const KEY = /\bt\(\s*['"]([a-zA-Z]+\.[A-Za-z0-9_.]+)['"]/g

// A key built at runtime is invisible to the regex above, and that is not a
// theoretical gap: PluginsPanel looks its bundled descriptions up as
// t(`plugins.builtin.${p.id}`), so every word an operator would actually
// search for -- 封包, tcpdump, Sliver, beacon, 透明 -- was in the interface
// and absent from the index. The search returned nothing and the feature
// might as well not have existed. A page that computes keys declares the
// prefix here and every matching key in the locale is pulled in, so adding a
// bundled plugin needs no edit to this file.
const COMPUTED_KEY_PREFIXES = {
  plugins: ['plugins.builtin.'],
  captureControl: ['settings.externalDesc.']
}

/** The i18n keys a page builds at runtime, read from the locale itself. */
export function computedKeys(page, allKeys) {
  const prefixes = COMPUTED_KEY_PREFIXES[page]
  if (!prefixes) return []
  return allKeys.filter((k) => prefixes.some((p) => k.startsWith(p))).sort()
}

/** The i18n keys a page renders, in first-seen order. `read` returns a
 *  component file's source by its path under src/renderer/src/components. */
export function pageKeys(page, read, allKeys = []) {
  const keys = []
  for (const { file, after, before } of PAGE_SOURCES[page]) {
    let src = read(file)
    if (after) src = src.slice(src.indexOf(after))
    if (before) src = src.slice(0, src.indexOf(before))
    for (const m of src.matchAll(KEY)) {
      // Toasts and shared button words are not something you look a setting up by.
      if (/^(toast|common)\./.test(m[1])) continue
      if (!keys.includes(m[1])) keys.push(m[1])
    }
  }
  for (const k of computedKeys(page, allKeys)) if (!keys.includes(k)) keys.push(k)
  return keys
}
