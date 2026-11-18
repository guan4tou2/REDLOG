// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Settings, { type SettingsPage } from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// The save bar speaks only when there is something to say: a write in flight,
// a write that landed, a write that failed. A permanent "changes save
// automatically" line sat on every page, including the ones whose values do
// not go through this form at all. When it does appear it floats over the
// bottom of the page instead of taking a row from it, so the scroll pane does
// not shrink and the page does not jump under the operator's pointer.

const text = en as Record<string, string>
type Op = { path: string[]; value?: unknown }
let release: ((ok: boolean) => void) | null = null

const config = (): Record<string, unknown> => ({
  engagement: { id: 'p-bar', activeTarget: null },
  operator: { id: 'op', name: 'Op' },
  network: { whitelist: [], blacklist: [], checkInterval: 61, providers: [], confirmations: 3, ipMode: 'auto', vpnAdapters: [] },
  scope: { warnOnViolation: true, targets: [], excludeTargets: [], personalDomains: [], scopeFile: '' },
  screenshot: { quality: 85 }, processMonitor: {}, connectionMonitor: {}, fileWatcher: {}, packs: {},
  loot: { disabledRules: [] }, retention: { loggedTier: { keepDays: 7 } }
})

beforeEach(() => {
  release = null
  localStorage.setItem('redlog-locale', 'en')
  let disk = config()
  const known: Record<string, unknown> = {
    platform: 'linux',
    config: {
      get: async () => structuredClone(disk),
      patch: (p: { ops: Op[] }) => new Promise((resolve) => {
        release = (ok) => {
          if (!ok) { resolve({ ok: false, reason: 'io' }); return }
          for (const op of p.ops) {
            let cur = disk as Record<string, unknown>
            for (const k of op.path.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
            cur[op.path[op.path.length - 1]] = op.value
          }
          disk = structuredClone(disk)
          resolve({ ok: true, config: structuredClone(disk), revision: 'r' })
        }
      })
    },
    project: { active: async () => ({ id: 'p-bar', name: 'A' }), close: async () => true },
    hooks: { detect: async () => [] },
    plugins: { list: async () => [], eventTypes: async () => [], officialAgents: async () => [] },
    loot: { rules: async () => [] }
  }
  const fallback = (): unknown => new Proxy({}, { get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null) })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, { get: (t, prop: string) => (prop in t ? t[prop] : fallback()) })
})
afterEach(() => { cleanup(); localStorage.clear() })

const mount = (page: SettingsPage | null): void => {
  render(<I18nProvider><Settings {...(page ? { request: { page } } : {})} /></I18nProvider>)
}

describe('the settings save bar', () => {
  it('is absent while nothing is being saved, on the home list and on a page', async () => {
    mount(null)
    await screen.findByTestId('settings-home')
    expect(screen.queryByTestId('settings-save-bar')).toBeNull()
    fireEvent.click(document.querySelector('[data-settings-page="network"]') as HTMLElement)
    await screen.findByLabelText(text['settings.checkInterval'])
    expect(screen.queryByTestId('settings-save-bar')).toBeNull()
  })

  it('appears for saving, then failed with a retry, and floats over the page instead of taking a row', async () => {
    mount('network')
    const input = await screen.findByLabelText(text['settings.checkInterval']) as HTMLInputElement
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.blur(input)
    const bar = await screen.findByTestId('settings-save-bar', {}, { timeout: 3000 })
    expect(screen.getByTestId('settings-save-saving')).toBeTruthy()
    // Out of the flex column: the content pane keeps its height when the bar
    // comes and goes.
    expect(bar.className).toMatch(/\babsolute\b/)
    expect(bar.parentElement!.className).toMatch(/\brelative\b/)
    release!(false)
    await screen.findByTestId('settings-save-failed')
    expect(screen.getByRole('button', { name: text['settings.save.retry'] })).toBeTruthy()
  })

  it('goes away again after a save lands', async () => {
    mount('network')
    const input = await screen.findByLabelText(text['settings.checkInterval']) as HTMLInputElement
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.blur(input)
    await screen.findByTestId('settings-save-bar', {}, { timeout: 3000 })
    release!(true)
    await screen.findByTestId('settings-save-saved')
    await waitFor(() => expect(screen.queryByTestId('settings-save-bar')).toBeNull(), { timeout: 3000 })
  })

  it('no longer ships the always-on line', () => {
    expect((en as Record<string, string>)['settings.autoSaveHint']).toBeUndefined()
    expect((zh as Record<string, string>)['settings.autoSaveHint']).toBeUndefined()
  })
})
