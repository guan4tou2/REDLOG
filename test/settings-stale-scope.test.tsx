// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Settings from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'

// Targets > "Add to scope" defers scope:addTarget by UNDO_MS (8 s) and then
// dispatches `redlog:config-saved`. Settings loads the whole document once at
// mount and config:save replaces the whole document, so a Settings opened
// inside that window would send its stale `scope.targets` with the next
// autosave and remove the new target. Settings re-reads the config when an
// outside save is announced.
//
// These run at the Settings <-> bridge boundary: config.get answers without the
// target at mount, the "deferred write" lands (the bridge now answers with it),
// and the save that goes out is inspected.

const saves: Array<Record<string, unknown>> = []
let stored: Record<string, unknown>

const baseConfig = (targets: string[]): Record<string, unknown> => ({
  engagement: { id: 'proj-a', name: 'A' },
  operator: { id: 'op' },
  packs: {}, screenshot: {}, clipboard: {}, processMonitor: {},
  connectionMonitor: {}, fileWatcher: {},
  scope: { targets, excludeTargets: [], personalDomains: [] }
})

beforeEach(() => {
  saves.length = 0
  stored = baseConfig([])
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    platform: 'win32',
    config: {
      get: async () => structuredClone(stored),
      save: async (c: Record<string, unknown>) => { saves.push(c); stored = structuredClone(c); return true }
    },
    project: { active: async () => ({ id: 'proj-a', name: 'A' }), close: async () => true },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }) },
    plugins: { list: async () => [], eventTypes: async () => [] },
    operators: { list: async () => [] }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
})
afterEach(() => cleanup())

const openScopePage = async (): Promise<HTMLInputElement> => {
  render(<I18nProvider><Settings request={{ page: 'scope' }} /></I18nProvider>)
  return await waitFor(() => {
    const el = document.querySelector('.flex-1 input') as HTMLInputElement | null
    expect(el).not.toBeNull()
    return el!
  })
}
const edit = (input: HTMLInputElement): void => {
  if (input.type === 'checkbox') fireEvent.click(input)
  else fireEvent.change(input, { target: { value: '10.0.0.9' } })
}
const outsideWrite = (targets: string[]): void => {
  stored = baseConfig(targets)
  window.dispatchEvent(new CustomEvent('redlog:config-saved')) // as TargetView does
}
const lastTargets = (): string[] => (saves.at(-1)!.scope as { targets: string[] }).targets

describe('Settings opened before a deferred scope:addTarget lands', () => {
  it('control: an edit with no outside write saves the form as it is', async () => {
    edit(await openScopePage())
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(lastTargets()).toEqual([])
  })

  it('does not remove the target the deferred write added', async () => {
    const input = await openScopePage()
    outsideWrite(['new.example'])
    // Give the re-read time to land, then make an unrelated edit.
    await waitFor(() => expect(input.isConnected).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    edit(document.querySelector('.flex-1 input') as HTMLInputElement)
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(lastTargets()).toContain('new.example')
  })

  it('takes the new target without writing anything when no edit is pending', async () => {
    await openScopePage()
    outsideWrite(['new.example'])
    await waitFor(() => expect(document.body.textContent).toContain('new.example'))
    await new Promise((r) => setTimeout(r, 600))
    expect(saves).toHaveLength(0)
  })

  it('keeps a pending edit and still takes the target an outside write added', async () => {
    const input = await openScopePage()
    edit(input) // pending: the debounce has not fired
    outsideWrite(['new.example'])
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(lastTargets()).toContain('new.example')
  })

  // The other half of the rule: when the edit waiting to be saved IS a change
  // to the list, the operator's list is what they meant to save. It is not
  // merged with the outside write, which they have not seen.
  it("keeps the operator's own list when the pending edit changed it", async () => {
    await openScopePage()
    const targets = document.querySelectorAll('textarea')[0] as HTMLTextAreaElement
    fireEvent.change(targets, { target: { value: '10.9.9.9' } })
    fireEvent.keyDown(targets, { key: 'Enter', ctrlKey: true })
    outsideWrite(['new.example'])
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 })
    expect(lastTargets()).toEqual(['10.9.9.9'])
  })
})
