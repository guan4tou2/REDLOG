// @vitest-environment jsdom
//
// #691: a failed config read left the dashboard's project summary silently
// absent. It now says the read failed, in the summary's place, with a retry.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { DashboardView } from '../src/renderer/src/components/DashboardView'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

const noop = (): void => {}
function install(configGet: () => Promise<unknown>): void {
  const named: Record<string, Record<string, unknown>> = {
    config: { get: vi.fn(configGet) },
    events: { getCount: async () => 0, onNewBatch: () => noop },
    chain: { length: async () => 0, anchors: async () => [] },
    capture: { health: async () => ({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    loot: { getCount: async () => 0 },
    pivots: { getActive: async () => [], onChange: () => noop }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); _resetCaptureHealth(); _resetIssues() })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('shows the summary as failed with a retry, and recovers', async () => {
  let fail = true
  install(async () => {
    if (fail) throw new Error('config locked')
    return { engagement: { id: 'ENG-9' }, operator: { name: 'op' }, scope: { targets: ['a.test'], excludeTargets: [] } }
  })
  render(<I18nProvider><DashboardView onNavigate={noop} projectName="p" /></I18nProvider>)
  const failed = await screen.findByTestId('dashboard-summary-failed')
  expect(failed.textContent).toContain('Settings could not be read')
  expect(screen.getByText('Project summary')).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('ENG-9')).toBeTruthy()
  expect(screen.queryByTestId('dashboard-summary-failed')).toBeNull()
})
