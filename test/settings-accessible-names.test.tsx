// @vitest-environment jsdom
//
// Every control on every settings page has an accessible name (accname, as
// dom-accessibility-api computes it; a placeholder does not count).
//
// A real-app audit reported nameless controls on Network, Scope, Browser and
// HUD. Computed here, Network had two (the custom VPN adapter's name and
// pattern boxes, placeholder only) and HUD one (the pass-through opacity
// slider beside its own label); both now take the name already on screen.
import { act, cleanup, render } from '@testing-library/react'
import { computeAccessibleName } from 'dom-accessibility-api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Settings, { type SettingsPage } from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'
import { DEFAULT_CONFIG, DEFAULT_VPN_ADAPTERS } from '../src/core/config'
import { DEFAULT_HUD_PREFS } from '../src/core/hud-prefs'

// The shipped defaults, plus one of everything a list can hold, so every
// per-row control is drawn.
const config = (): Record<string, unknown> => {
  const c = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, Record<string, unknown>>
  c.engagement = { ...c.engagement, id: 'proj-a', name: 'A' }
  c.scope = { ...c.scope, targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.1'], personalDomains: ['mail.example.test'] }
  c.network = { ...c.network, whitelist: ['198.51.100.7'], blacklist: ['203.0.113.9'], providers: ['https://ip.example.test/json'],
    vpnAdapters: [...DEFAULT_VPN_ADAPTERS, { name: 'Lab', pattern: '^lab', enabled: true }] }
  return c
}

beforeEach(() => {
  try { localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    platform: 'darwin',
    config: { get: async () => config(), save: async () => true },
    project: { active: async () => ({ id: 'proj-a', name: 'A' }), close: async () => true },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }) },
    plugins: { list: async () => [], eventTypes: async () => [] },
    operators: { list: async () => [] },
    // Pass-through on, so its opacity slider is drawn.
    hudPrefs: { get: async () => ({ ...DEFAULT_HUD_PREFS, passThrough: true }), set: async (p: object) => ({ ...DEFAULT_HUD_PREFS, ...p }), onChanged: () => () => {} },
    loot: { rules: async () => [{ id: 'aws-key', type: 'credential', confidence: 'high', pluginId: null, description: 'AWS access key' }] },
    chain: { anchors: async () => [] },
    app: {
      updateStatus: async () => ({ stage: 'idle', method: 'in-app', packaged: true, currentVersion: '1.0.0', targetVersion: null, progress: null, result: null, checkedAt: null, releaseUrl: 'https://example.test', autoCheck: true, unfinished: false }),
      onUpdateStatus: () => () => {}
    },
    debug: { status: async () => ({ enabled: false, path: '/tmp/x' }) }
  }
  known.hooks = {
    ...(known.hooks as object),
    detect: async () => [
      { id: 'zsh', builtin: true, name: 'zsh', description: 'zsh', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source', hookFile: '/tmp/h.zsh' },
      { id: 'bash', builtin: true, name: 'bash', description: 'bash', agentType: 'shell', installed: false, available: true, installMethod: 'shell-source', hookFile: '/tmp/h.sh', manualSteps: [{ label: 'Source it', command: 'source /tmp/h.sh' }] }
    ]
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
})
afterEach(() => cleanup())

const CONTROLS = 'input:not([type="hidden"]), select, textarea, button, [role="switch"], [role="checkbox"]'

function nameless(root: Element): string[] {
  const out: string[] = []
  for (const el of root.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (el.closest('[hidden], [aria-hidden="true"]')) continue
    if (computeAccessibleName(el).trim() === '') {
      out.push(el.outerHTML.slice(0, 140))
    }
  }
  return out
}


const PAGES: SettingsPage[] = ['hooks', 'captureControl', 'browser', 'scope', 'network', 'loot', 'retention', 'integrity', 'general', 'hud', 'plugins', 'about']

describe.each(PAGES)('settings page %s', (page) => {
  it('names every control', async () => {
    render(<I18nProvider><Settings request={{ page }} /></I18nProvider>)
    // Let the config and the page's own reads land.
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    // More than the back button: the page body itself drew.
    expect(document.querySelectorAll(CONTROLS).length).toBeGreaterThan(1)
    const missing = nameless(document.body)
    expect(missing).toEqual([])
  })
})
