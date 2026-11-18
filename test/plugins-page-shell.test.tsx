// @vitest-environment jsdom
//
// The Plugins page inside Settings (2026-11-14 layout leftovers): one heading,
// one way back per level, no save bar while nothing is saving, and
// the list's two actions at one button size.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import Settings from '../src/renderer/src/components/Settings'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'

const CONFIG = {
  engagement: { id: 'proj-a', name: 'A' }, operator: { id: 'op' }, overlay: {}, packs: {}, screenshot: {},
  processMonitor: {}, connectionMonitor: {}, fileWatcher: {}, scope: { targets: [], excludeTargets: [], personalDomains: [] }
}
const plugin = {
  officialAgent: false, id: 'alpha', name: 'Plugin alpha', version: '1.0.0', description: '', author: 'me',
  source: 'user', tier: 'declarative', status: 'active', capabilities: [], contributes: []
}

beforeEach(() => {
  _resetCaptureHealth()
  localStorage.clear()
  localStorage.setItem('redlog-locale', 'en')
  const fallback = (): unknown => new Proxy({}, { get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null) })
  const known: Record<string, unknown> = {
    platform: 'darwin',
    config: { get: async () => structuredClone(CONFIG), save: async () => true },
    plugins: {
      list: vi.fn(async () => [plugin]), officialAgents: vi.fn(async () => []), reload: vi.fn(async () => [plugin]),
      openFolder: vi.fn(), setEnabled: vi.fn(), grant: vi.fn(), revoke: vi.fn(), eventTypes: async () => []
    },
    events: { onNewBatch: () => () => {} }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
})
afterEach(() => { cleanup(); localStorage.clear() })

const onPlugins = async (): Promise<HTMLElement> => {
  render(<I18nProvider><Settings request={{ page: 'plugins' }} /></I18nProvider>)
  await screen.findByTestId('plugin-details-alpha')
  return screen.getByTestId('settings-content')
}

describe('the Plugins page in Settings', () => {
  it('names the page once', async () => {
    const content = await onPlugins()
    expect(within(content).getAllByText('Plugins', { exact: true })).toHaveLength(1)
  })

  it('has one back control, and it goes up one level at a time: detail to list, list to Settings', async () => {
    const content = await onPlugins()
    const back = (): HTMLElement => screen.getByTestId('settings-back')
    expect(back().textContent).toBe('← Back to Settings')
    fireEvent.click(screen.getByTestId('plugin-details-alpha'))
    const detail = await screen.findByTestId('plugin-detail-alpha')
    // The detail draws no back control of its own.
    expect(within(detail).queryByText(/Back to/)).toBeNull()
    expect(within(content).getAllByText(/Back to/)).toHaveLength(1)
    expect(back().textContent).toBe('← Back to list')
    fireEvent.click(back())
    await screen.findByTestId('plugin-details-alpha')
    expect(screen.queryByTestId('plugin-detail-alpha')).toBeNull()
    expect(back().textContent).toBe('← Back to Settings')
    fireEvent.click(back())
    expect(screen.getByTestId('settings-home')).toBeTruthy()
  })

  it('draws no save bar while nothing is being saved, here or back on the Settings list', async () => {
    // The bar used to carry a permanent "changes save automatically" line on
    // every page but this one; it now appears only for saving / saved / failed
    // (test/settings-save-bar.test.tsx).
    await onPlugins()
    expect(screen.queryByTestId('settings-save-bar')).toBeNull()
    fireEvent.click(screen.getByTestId('settings-back'))
    await waitFor(() => expect(screen.getByTestId('settings-home')).toBeTruthy())
    expect(screen.queryByTestId('settings-save-bar')).toBeNull()
  })

  it('draws Open folder and Reload at one button size, the quieter one still quieter', async () => {
    await onPlugins()
    const folder = screen.getByRole('button', { name: 'Open folder' })
    const reload = screen.getByRole('button', { name: 'Reload' })
    for (const b of [folder, reload]) {
      expect(b.className).toContain('min-h-7')
      expect(b.className).toContain('text-xs')
    }
    expect(folder.className).not.toBe(reload.className)
  })
})
