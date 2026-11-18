// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Settings, { type SettingsPage } from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'

// When a setting saves and what the operator sees:
//  - a number field commits when it is left (or Enter), never per keystroke,
//    so clearing it to type a new value does not save a default.

const text = en as Record<string, string>
type Op = { path: string[]; value?: unknown }
const ops: Op[][] = []

const config = (): Record<string, unknown> => ({
  engagement: { id: 'p-save', activeTarget: null },
  operator: { id: 'op', name: 'Op' },
  network: { whitelist: [], blacklist: [], checkInterval: 61, providers: [], confirmations: 3, ipMode: 'auto', vpnAdapters: [] },
  scope: { warnOnViolation: true, targets: [], excludeTargets: [], personalDomains: [], scopeFile: '' },
  screenshot: { quality: 85 }, processMonitor: {}, connectionMonitor: {}, fileWatcher: {}, packs: {},
  browser: { binary: '', proxy: '', cdpPort: 9222, isolateProfile: true, ignoreCertErrors: false, startUrl: '', extraArgs: [] },
  httpCapture: { port: 6661, listenHost: '127.0.0.1', routeTerminals: false },
  loot: { disabledRules: [] },
  retention: { loggedTier: { keepDays: 7 } }
})

beforeEach(() => {
  ops.length = 0
  let disk = config()
  const known: Record<string, unknown> = {
    platform: 'linux',
    config: {
      get: async () => structuredClone(disk),
      patch: async (p: { ops: Op[] }) => {
        ops.push(p.ops)
        for (const op of p.ops) {
          let cur = disk as Record<string, unknown>
          for (const k of op.path.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
          cur[op.path[op.path.length - 1]] = op.value
        }
        return { ok: true, config: structuredClone(disk), revision: 'r' }
      }
    },
    project: { active: async () => ({ id: 'p-save', name: 'A' }), close: async () => true },
    hooks: { detect: async () => [] },
    plugins: { list: async () => [], eventTypes: async () => [], officialAgents: async () => [] },
    operators: { list: async () => [] },
    browser: { detect: async () => null, status: async () => ({ running: false }) }
  }
  const fallback = (): unknown => new Proxy({}, { get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null) })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, { get: (t, prop: string) => (prop in t ? t[prop] : fallback()) })
})
afterEach(() => cleanup())

const mount = (page: SettingsPage): void => { render(<I18nProvider><Settings request={{ page }} /></I18nProvider>) }
const field = async (label: string): Promise<HTMLInputElement> => await screen.findByLabelText(text[label]) as HTMLInputElement

describe('a number field commits when it is left, not per keystroke', () => {
  const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('shows an emptied field as empty and saves nothing, then saves the typed value on blur', async () => {
    mount('network')
    const input = await field('settings.checkInterval')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    await settle()
    expect(input.value).toBe('')
    expect(ops).toHaveLength(0)
    fireEvent.change(input, { target: { value: '45' } })
    await settle()
    expect(ops).toHaveLength(0)
    fireEvent.blur(input)
    await waitFor(() => expect(ops).toHaveLength(1), { timeout: 3000 })
    expect(ops[0].find((o) => o.path.join('.') === 'network.checkInterval')?.value).toBe(45)
  })

  it('Enter commits', async () => {
    mount('network')
    const input = await field('settings.confirmations')
    input.focus()
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(ops).toHaveLength(1), { timeout: 3000 })
  })

  it('an empty or out-of-range entry is not saved; the field says what is allowed', async () => {
    mount('captureControl')
    const input = await field('settings.jpegQuality').catch(async () => {
      fireEvent.click(await screen.findByText(text['settings.screenshot.options']))
      return field('settings.jpegQuality')
    })
    for (const bad of ['', '101', '0', '-3', '7.5']) {
      fireEvent.change(input, { target: { value: bad } })
      fireEvent.blur(input)
      expect(await screen.findByText(text['settings.numberInvalidRange'].replace('{{min}}', '1').replace('{{max}}', '100'))).toBeTruthy()
    }
    await settle()
    expect(ops).toHaveLength(0)
    fireEvent.change(input, { target: { value: '70' } })
    fireEvent.blur(input)
    await waitFor(() => expect(ops).toHaveLength(1), { timeout: 3000 })
  })
})
