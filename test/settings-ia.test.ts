import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// §10 and the phase-3 acceptance gate: every setting reachable in ≤2 levels.
//
// Eight tabs in one 13px row was already hard to scan, and two of them —
// "Integrations" and "Data" — had drifted into meaning roughly the same thing.
// Below that, Plugins held sub-tabs and those held publisher and revocation
// lists: three levels underneath the second level.
//
// The container had to come first. Twelve categories fit down a side and do
// not fit across a top, so the content could not be split until there was
// somewhere to put it.
//
// There is no "export" page. Exporting is an action, not a setting, and it
// was three separate groups here before §10 collapsed every entry point into
// one control in the shell. This list is the guard against it drifting back.

const ROOT = path.join(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/Settings.tsx'), 'utf-8')

const PAGES = [
  'hooks', 'agents', 'captureControl',
  'scope', 'network', 'deconfliction',
  'integrity',
  'operators', 'cloud', 'plugins',
  'general', 'hud'
]

describe('settings information architecture', () => {
  it('declares twelve pages as a union', () => {
    const block = /type SettingsPage =([\s\S]*?)\n\n/.exec(SRC)
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

  it('has a search box over the categories', () => {
    expect(SRC).toMatch(/settings\.searchPages/)
    expect(SRC).toMatch(/pageQuery/)
  })

  it('flattens plugins to two levels', () => {
    // The marker of the old shape was a second `useState` for a sub-tab
    // inside the page. Installed and marketplace are sections now, not
    // destinations.
    const tab = SRC.slice(SRC.indexOf('function PluginsTab'))
    const body = tab.slice(0, tab.indexOf('\n}'))
    expect(body, 'a sub-tab selector is the third level').not.toMatch(/useState<'installed'/)
    expect(body).toMatch(/<PluginsPanel/)
    expect(body).toMatch(/<MarketplacePanel/)
  })
})
