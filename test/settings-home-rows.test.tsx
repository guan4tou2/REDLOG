// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Settings home: one line per page — the page's name, its current value
// when that is cheap and certain, and `›`. The row and the page it opens use
// one name (five pages had two). A value whose read failed is not shown,
// rather than shown as 0.

const PAGES = ['hooks', 'browser', 'captureControl', 'scope', 'network', 'loot', 'plugins', 'retention', 'general', 'hud', 'about']
const CONFIG = {
  engagement: { id: 'proj-a', name: 'A' }, operator: { id: 'op' }, overlay: {}, packs: {}, screenshot: {},
  processMonitor: {}, connectionMonitor: {}, fileWatcher: {},
  scope: { targets: ['10.0.0.1', '10.0.0.2'], excludeTargets: ['10.0.0.9'], personalDomains: [] },
  loot: { disabledRules: ['b'] }, retention: { loggedTier: { keepDays: 30 } },
  network: { whitelist: [], blacklist: [], checkInterval: 61, providers: [], confirmations: 3, ipMode: 'auto', vpnAdapters: [] },
  browser: { binary: '', proxy: '', cdpPort: 9222, isolateProfile: true, ignoreCertErrors: false, startUrl: '', extraArgs: [] },
  httpCapture: { port: 6661, listenHost: '127.0.0.1', routeTerminals: false }
}
const plugin = (id: string): Record<string, unknown> => ({
  officialAgent: false, id, name: id, version: '1.0.0', description: '', author: 'me',
  source: 'user', tier: 'declarative', status: 'active', capabilities: [], contributes: []
})
let lootRules: () => Promise<unknown>
let pluginList: () => Promise<unknown>

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'en')
  lootRules = async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  // `starter-pack` is listed by main but not on the Plugins page.
  pluginList = async () => [plugin('alpha'), plugin('beta'), plugin('starter-pack')]
  const fallback = (): unknown => new Proxy({}, { get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null) })
  const known: Record<string, unknown> = {
    platform: 'darwin',
    config: { get: async () => structuredClone(CONFIG), patch: async () => ({ ok: true, config: structuredClone(CONFIG) }) },
    loot: { rules: vi.fn(() => lootRules()) },
    plugins: { list: vi.fn(() => pluginList()), officialAgents: async () => [], eventTypes: async () => [] },
    events: { onNewBatch: () => () => {} }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, { get: (t, prop: string) => (prop in t ? t[prop] : fallback()) })
})
afterEach(() => { cleanup(); localStorage.clear() })

const home = async (): Promise<HTMLElement> => {
  render(<I18nProvider><Settings /></I18nProvider>)
  return screen.findByTestId('settings-home')
}
const row = (id: string): HTMLElement => document.querySelector(`[data-settings-page="${id}"]`) as HTMLElement

describe('the Settings home', () => {
  it('names each row exactly as the page it opens names itself', async () => {
    // The page heading is `pageLabel.get(tab)`; the row must read the same
    // map, not a home-only key of its own.
    const src = readFileSync(join(__dirname, '../src/renderer/src/components/Settings.tsx'), 'utf8')
    expect(src).toMatch(/<h2[^>]*>\{pageLabel\.get\(tab\)\}<\/h2>/)
    await home()
    for (const id of PAGES) {
      const key = `settings.page${id[0].toUpperCase()}${id.slice(1)}`
      expect(screen.getByTestId(`settings-home-title-${id}`).textContent, id).toBe((en as Record<string, string>)[key])
    }
    // Opening one shows that same string as its heading.
    const title = screen.getByTestId('settings-home-title-retention').textContent
    fireEvent.click(row('retention'))
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(title)
  })

  it('has no subtitle, no per-row description and no action word', async () => {
    const el = await home()
    expect(el.textContent).not.toMatch(/Manage RedLog|Manage|Go to scope settings|Shell hooks and PTY/)
    for (const dict of [en, zh] as Array<Record<string, string>>) {
      const left = Object.keys(dict).filter((k) => /^settings\.home\.(subtitle|manage|view|openScope|\w+\.(desc|title))$/.test(k))
      expect(left).toEqual([])
    }
  })

  it('shows the current value where it is known', async () => {
    await home()
    await waitFor(() => expect(row('loot').textContent).toContain('2 on'))
    await waitFor(() => expect(row('plugins').textContent).toContain('2 installed'))
    expect(row('retention').textContent).toContain('30 days')
    expect(row('about').textContent).toMatch(/v\d+\.\d+\.\d+/)
    expect(row('scope').textContent).toContain('2 targets · 1 excluded')
    for (const id of PAGES) expect(row(id).textContent?.trim().endsWith('›'), id).toBe(true)
  })

  it('shows nothing, not 0, when a count could not be read', async () => {
    lootRules = async () => { throw new Error('ipc down') }
    pluginList = async () => { throw new Error('ipc down') }
    await home()
    await waitFor(() => expect((window.redlog.plugins.list as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(row('loot').textContent).not.toMatch(/\d/)
    expect(row('plugins').textContent).not.toMatch(/\d/)
  })
})
