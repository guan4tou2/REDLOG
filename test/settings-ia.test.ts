import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// §10 and the phase-3 acceptance gate: every setting reachable in ≤2 levels.
//
// Eight tabs in one 13px row was already hard to scan, and two of them —
// "Integrations" and "Data" — had drifted into meaning roughly the same thing.
// Below that, Plugins held sub-tabs and those held publisher and revocation
// lists: three levels underneath the second level. That whole branch is gone
// now — see the marketplace test below for why removing beat flattening.
//
// The container had to come first. Eleven categories fit down a side and do
// not fit across a top, so the content could not be split until there was
// somewhere to put it.
//
// There is no "export" page. Exporting is an action, not a setting, and it
// was three separate groups here before §10 collapsed every entry point into
// one control in the shell. This list is the guard against it drifting back.

const ROOT = path.join(__dirname, '..')
const R = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const SRC = R('src/renderer/src/components/Settings.tsx')
const SETTINGS_DIR = path.join(ROOT, 'src/renderer/src/components/settings')

const PAGES = [
  'hooks', 'agents', 'captureControl',
  'scope', 'network',
  'integrity',
  'plugins',
  'general', 'hud'
]

describe('settings information architecture', () => {
  it('declares nine pages as a union', () => {
    // CRLF-safe: .tsx files check out with \r\n on Windows (.gitattributes only
    // pins .sh/.py to LF), so a bare \n\n never matches there — the same
    // line-ending trap the repo hit once before with path.sep.
    const block = /type SettingsPage =([\s\S]*?)\r?\n\r?\n/.exec(SRC)
    expect(block, 'SettingsPage union not found').not.toBeNull()
    for (const page of PAGES) {
      expect(block![1], `missing page: ${page}`).toContain(`'${page}'`)
    }
  })

  it('routes every declared page to content', () => {
    // A page in the list with no `tab === 'x'` anywhere renders an empty pane,
    // which looks like a bug in the setting rather than a missing route.
    const unrouted = PAGES.filter((page) => !new RegExp(`tab === '${page}'`).test(SRC))
    expect(unrouted).toEqual([])
  })

  it('offers every declared page in the left list', () => {
    // And the reverse: content reachable by no list entry is content nobody
    // finds.
    const listed = [...SRC.matchAll(/id: '(\w+)' as SettingsPage|\{ id: '(\w+)',/g)]
      .map((m) => m[1] ?? m[2])
      .filter((id) => PAGES.includes(id))
    expect([...new Set(listed)].sort()).toEqual([...PAGES].sort())
  })

  it('keeps exporting out of settings', () => {
    // The three groups that used to live here — export all, export the
    // filtered scope, build an evidence bundle — were actions wearing a
    // settings page. Each was also a fourth place to look for the same verb.
    expect(SRC).not.toMatch(/data\.export(Json|Bundle|ScopeFiltered)/)
    expect(SRC).not.toMatch(/tab === 'export'/)
  })

  it('has a filter box over the categories', () => {
    expect(SRC).toMatch(/settings\.filterPages/)
    expect(SRC).toMatch(/pageQuery/)
  })

  // It matches page names only. "Search settings…" promised the fields on
  // those pages, and typing a setting's own name found nothing.
  it('says the box filters categories, not settings', () => {
    const en = JSON.parse(R('src/renderer/src/i18n/en.json')) as Record<string, string>
    const zh = JSON.parse(R('src/renderer/src/i18n/zh-TW.json')) as Record<string, string>
    expect(en['settings.filterPages']).toBe('Filter categories…')
    expect(zh['settings.filterPages']).toBe('篩選分類…')
  })

  it('flattens plugins to one level', () => {
    // The marker of the old shape was a second `useState` for a sub-tab
    // inside the page. There is one section left, so there is nothing to
    // select between. After decomposition the panel lives in settings/.
    const pluginsSrc = R('src/renderer/src/components/settings/PluginsPanel.tsx')
    expect(pluginsSrc, 'a sub-tab selector is the third level').not.toMatch(/useState<'installed'/)
    // Settings routes to PluginsPanel directly (no wrapper)
    expect(SRC).toMatch(/<PluginsPanel/)
  })

  it('keeps the group count from creeping back', () => {
    // positioning risk #2 names "8 tabs / 34 groups" as the symptom of breadth
    // outrunning the persona. The number is a proxy, but it is the proxy that
    // was measured, so it is the one worth holding — a group added without a
    // group removed should have to argue for itself in a diff.
    // After decomposition, FieldGroups live in the settings/ directory.
    const allSettingsSrc = [
      SRC,
      ...fs.readdirSync(SETTINGS_DIR)
        .filter((f: string) => f.endsWith('.tsx'))
        .map((f: string) => R(`src/renderer/src/components/settings/${f}`))
    ].join('\n')
    const groups = (allSettingsSrc.match(/<FieldGroup title=/g) ?? []).length
    expect(groups, 'a new settings group needs a reason, not just a place').toBeLessThanOrEqual(29)
  })

  it('does not ship a cloud share backend', () => {
    // Uploading an evidence bundle to a backend with an expiry is
    // distribution infrastructure — the same argument that removed the
    // marketplace, and heavier: §1 makes the operator writing the engagement
    // up the consumer of the output. The bundle itself stays, in the one
    // export control; how it reaches anyone else is the operator's business.
    expect(SRC).not.toMatch(/CloudSharePanel|cloudShare/)
    expect(fs.existsSync(path.join(ROOT, 'src/core/cloud-share.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'src/core/cloud-share-uploader.ts'))).toBe(false)
  })

  it('does not ship a marketplace', () => {
    // Browsing a registry, pinning publishers by Ed25519 fingerprint, and
    // reading revocation lists are the machinery of distributing capture
    // code. The core is "nothing missing, findable afterwards"
    // (docs/DESIGN-core-and-capture.md §1) — distribution serves
    // extensibility, which is a different product.
    //
    // What stays is the installed list, because an operator does need to
    // answer "is anything capturing that I did not put there".
    expect(SRC).not.toMatch(/MarketplacePanel|PublisherEditor/)
    expect(fs.existsSync(path.join(ROOT, 'src/core/plugins/marketplace.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'src/core/plugins/publisher-trust.ts'))).toBe(false)
    // The signing CLI existed to produce registry entries. No registry, no
    // entries — and a `redlog-sign` on someone's PATH that signs for nothing
    // is worse than its absence.
    expect(fs.existsSync(path.join(ROOT, 'cli/redlog-sign.js'))).toBe(false)
    const pkg = JSON.parse(R('package.json'))
    expect(Object.keys(pkg.bin)).toEqual(['redlog-cli'])
  })
})
