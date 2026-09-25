// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'

// App renders Settings as `view === 'settings' && <Settings/>`, so navigating
// away unmounts it. The 350ms autosave debounce cancelled its pending write in
// the effect cleanup, so a change made within 350ms of leaving the page was
// dropped — silently, with the operator having seen the control move.

const saves: Array<{ config: Record<string, unknown>; opts?: { expectProjectId?: string } }> = []
let saveResult: boolean | Promise<boolean> = true

const CONFIG = {
  engagement: { id: 'proj-a', name: 'A' },
  operator: { id: 'op' },
  overlay: {},
  packs: {},
  screenshot: {},
  clipboard: {},
  processMonitor: {},
  connectionMonitor: {},
  fileWatcher: {},
  scope: { targets: [], excludeTargets: [], personalDomains: [] }
}

function installBridge(): void {
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    platform: 'win32',
    config: {
      get: async () => structuredClone(CONFIG),
      save: async (config: Record<string, unknown>, opts?: { expectProjectId?: string }) => {
        saves.push({ config, opts })
        return saveResult
      }
    },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }) },
    plugins: { list: async () => [], eventTypes: async () => [] },
    operators: { list: async () => [] }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
}

// `scope` is a plain form over config: no plugin registry, no hook detection,
// so its controls render from the config alone.
/** Any edit that makes Settings mark itself dirty. */
const change = (el: HTMLInputElement): void => {
  if (el.type === 'checkbox') fireEvent.click(el)
  else fireEvent.change(el, { target: { value: `10.0.0.${Math.floor(Math.random() * 200) + 1}` } })
}

const mount = (): { unmount: () => void } =>
  render(<I18nProvider><Settings request={{ page: 'scope' }} /></I18nProvider>)

describe('the settings autosave does not lose a change on the way out', () => {
  beforeEach(() => {
    saves.length = 0
    saveResult = true
    installBridge()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks() })

  /** Wait for the initial config fetch to land: the form is rendered once it
   *  has, and until then Settings shows only a loading line. */
  const ready = async (): Promise<HTMLInputElement> =>
    await waitFor(() => {
      const el = document.querySelector('[data-testid="view-root"] input, .flex-1 input') as HTMLInputElement | null
      expect(el).not.toBeNull()
      return el!
    })

  it('flushes a pending write when the page is left inside the debounce', async () => {
    const view = mount()
    const toggle = await ready()
    change(toggle)
    expect(saves).toHaveLength(0)   // still inside the 350ms window

    view.unmount()
    await waitFor(() => expect(saves.length).toBeGreaterThan(0))
  })

  it('binds the write to the project the form was loaded from', async () => {
    mount()
    change(await ready())
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].opts?.expectProjectId).toBe('proj-a')
  })

  it('says when a save failed, and keeps the change so it can be retried', async () => {
    saveResult = false
    mount()
    change(await ready())
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(await screen.findByTestId('settings-save-failed')).not.toBeNull()

    saveResult = true
    fireEvent.click(screen.getByRole('button', { name: /Retry|重試/ }))
    await waitFor(() => expect(screen.queryByTestId('settings-save-saved')).not.toBeNull())
  })
})
