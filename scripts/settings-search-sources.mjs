// Which source files make up each Settings page, for the field-search index
// (src/renderer/src/lib/settingsSearchIndex.ts) and the test that keeps that
// index in step with the pages. `after` takes the file from that marker on;
// `before` up to it — AgentsPanel.tsx holds two panels shown on two pages.
export const PAGE_SOURCES = {
  hooks: [
    { file: 'settings/HooksPanel.tsx' },
    { file: 'WslPanel.tsx' },
    { file: 'settings/AgentsPanel.tsx', after: 'export function HookWatchPathsPanel' }
  ],
  agents: [{ file: 'settings/AgentsPanel.tsx', before: 'export function HookWatchPathsPanel' }],
  captureControl: [{ file: 'settings/CaptureControlPage.tsx' }, { file: 'settings/LootRulesGroup.tsx' }],
  scope: [{ file: 'settings/ScopePage.tsx' }],
  network: [{ file: 'settings/NetworkPage.tsx' }],
  integrity: [{ file: 'settings/IntegrityPanel.tsx' }],
  plugins: [{ file: 'settings/PluginsPanel.tsx' }],
  general: [{ file: 'settings/GeneralPage.tsx' }],
  hud: [{ file: 'settings/HudPage.tsx' }]
}

const KEY = /\bt\(\s*['"]([a-zA-Z]+\.[A-Za-z0-9_.]+)['"]/g

/** The i18n keys a page renders, in first-seen order. `read` returns a
 *  component file's source by its path under src/renderer/src/components. */
export function pageKeys(page, read) {
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
  return keys
}
