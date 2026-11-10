// @vitest-environment jsdom
//
// Spec 069 T019: the heading, tab counts and rule state shared by Targets and
// Scope. A failed read of the rules is its own state — never "not set".

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TargetsScopeHeader } from '../src/renderer/src/components/TargetsScopeHeader'

type Cfg = { scope?: { targets?: string[]; excludeTargets?: string[] } }
function install(config: () => Promise<Cfg>, observations = 2, targets = 5): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    config: { get: vi.fn(config) },
    events: {
      aggregateTargets: async () => Array.from({ length: targets }, (_, i) => ({ target: `t${i}`, eventCount: 1, firstSeen: 0, lastSeen: 0 })),
      getCount: async () => 0, onNewBatch: () => () => {}
    },
    chain: { length: async () => 0 },
    loot: { getCount: async () => 0 },
    scope: { getObservationCount: async () => observations, isConfigured: async () => true }
  }
}
const onNavigate = vi.fn()
const onOpenSettings = vi.fn()
const mount = (page: 'targets' | 'scope' = 'targets'): void => {
  render(<I18nProvider><TargetsScopeHeader page={page} onNavigate={onNavigate} onOpenSettings={onOpenSettings} /></I18nProvider>)
}
beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); onNavigate.mockReset(); onOpenSettings.mockReset() })
afterEach(() => cleanup())

it('shows both counts on the tabs, and moves between the pages', async () => {
  install(async () => ({ scope: { targets: ['a'], excludeTargets: [] } }))
  mount()
  await waitFor(() => expect(screen.getByTestId('tab-count-targets').textContent).toBe('5'))
  await waitFor(() => expect(screen.getByTestId('tab-count-scope').textContent).toBe('2'))
  fireEvent.click(screen.getByRole('tab', { name: /Scope observations/ }))
  expect(onNavigate).toHaveBeenCalledWith('scope')
  expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Targets')
})

it('says the rules are set, with how many allow and exclude', async () => {
  install(async () => ({ scope: { targets: ['a', 'b', 'c'], excludeTargets: ['x'] } }))
  mount()
  expect(await screen.findByText('Scope rules are set')).toBeTruthy()
  const strip = screen.getByTestId('scope-context')
  expect(strip.textContent).toContain('Allowed 3')
  expect(strip.textContent).toContain('Excluded 1')
})

it('says scope is not set, and offers the settings', async () => {
  install(async () => ({ scope: { targets: [], excludeTargets: [] } }))
  mount()
  expect(await screen.findByText('Scope is not set')).toBeTruthy()
  // Not set has no count to give: a dash, not a 0 that reads as a measurement.
  expect(screen.getByTestId('tab-count-scope').textContent).toBe('—')
  fireEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
  expect(onOpenSettings).toHaveBeenCalledOnce()
})

it('a failed read is not "not set", and retrying recovers', async () => {
  let fail = true
  install(async () => { if (fail) throw new Error('refused'); return { scope: { targets: ['a'], excludeTargets: [] } } })
  mount()
  expect(await screen.findByText('Scope rules could not be read')).toBeTruthy()
  expect(screen.queryByText('Scope is not set')).toBeNull()
  expect(screen.getByTestId('tab-count-scope').textContent).toBe('—')
  fail = false
  fireEvent.click(screen.getByTestId('scope-context-retry'))
  expect(await screen.findByText('Scope rules are set')).toBeTruthy()
})
