// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'
import { closeProjectAfterSaves } from '../src/renderer/src/lib/pendingSaves'

// App renders Settings as `view === 'settings' && <Settings/>`, so navigating
// away unmounts it. The 350ms autosave debounce cancelled its pending write in
// the effect cleanup, so a change made within 350ms of leaving the page was
// dropped — silently, with the operator having seen the control move.

const saves: Array<{ config: Record<string, unknown>; opts?: { expectProjectId?: string } }> = []
let saveResult: boolean | Promise<boolean> = true
/** The order main saw the calls in: `save` and `close`. */
const calls: string[] = []
let getConfig: () => Promise<unknown>

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
      get: () => getConfig(),
      save: async (config: Record<string, unknown>, opts?: { expectProjectId?: string }) => {
        calls.push('save')
        saves.push({ config, opts })
        return saveResult
      }
    },
    project: { close: async () => { calls.push('close') } },
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
    calls.length = 0
    saveResult = true
    getConfig = async () => structuredClone(CONFIG)
    installBridge()
  })
  // No fake timers. The debounce is 350ms, so real waits are enough, and
  // faking the clock here left this file failing at file level under a full
  // suite run while passing on its own — the component schedules its own
  // timeouts and the interaction was not worth the speed.
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(saves[0].opts?.expectProjectId).toBe('proj-a')
  })

  it('says when a save failed, and keeps the change so it can be retried', async () => {
    saveResult = false
    mount()
    change(await ready())
    expect(await screen.findByTestId('settings-save-failed', {}, { timeout: 3000 })).not.toBeNull()

    saveResult = true
    fireEvent.click(screen.getByRole('button', { name: /Retry|重試/ }))
    await waitFor(() => expect(screen.queryByTestId('settings-save-saved')).not.toBeNull())
  })

  // #223: App awaited project.close() and only then unmounted Settings, so the
  // unmount flush reached main with no project open, was refused, and nothing
  // said so. These drive the same path App's close button takes.
  describe('closing the project', () => {
    it('writes the pending change to this project before closing it', async () => {
      const view = mount()
      change(await ready())
      expect(saves).toHaveLength(0)   // still inside the debounce

      expect(await closeProjectAfterSaves()).toBe(true)
      expect(calls).toEqual(['save', 'close'])
      expect(saves[0].opts?.expectProjectId).toBe('proj-a')
      // Unmounting afterwards finds nothing left to write.
      view.unmount()
      await new Promise((r) => setTimeout(r, 400))
      expect(saves).toHaveLength(1)
    })

    it('keeps the project open when the save fails, and saves on the next try', async () => {
      saveResult = false
      mount()
      change(await ready())
      expect(await closeProjectAfterSaves()).toBe(false)
      expect(calls).not.toContain('close')

      saveResult = true
      expect(await closeProjectAfterSaves()).toBe(true)
      expect(calls.at(-1)).toBe('close')
      expect(saves.at(-1)!.opts?.expectProjectId).toBe('proj-a')
    })

    it('closes straight away when nothing is pending', async () => {
      mount()
      await ready()
      expect(await closeProjectAfterSaves()).toBe(true)
      expect(calls).toEqual(['close'])
    })
  })

  it('says when the settings could not be read, and loads them on retry', async () => {
    let fail = true
    getConfig = async () => { if (fail) throw new Error('no config'); return structuredClone(CONFIG) }
    mount()
    expect(await screen.findByTestId('settings-load-failed')).not.toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Check again|重新檢查/ }))
    await ready()
    expect(screen.queryByTestId('settings-load-failed')).toBeNull()
  })

  // #223: under React.StrictMode the form is mounted, cleaned up and mounted
  // again. `live` only ever went false, so a save never showed its state.
  it('shows save state under React.StrictMode', async () => {
    render(<StrictMode><I18nProvider><Settings request={{ page: 'scope' }} /></I18nProvider></StrictMode>)
    change(await ready())
    await waitFor(() => expect(screen.queryByTestId('settings-save-saved')).not.toBeNull(), { timeout: 3000 })
  })
})
