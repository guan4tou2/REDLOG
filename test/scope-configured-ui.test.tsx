// @vitest-environment jsdom
//
// #690: one definition of "scope configured" — core's ScopePolicy.isConfigured,
// at least one allowed target. Exclusions alone are not a scope. The header,
// the dashboard and the Targets page must agree with it and with each other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TargetsScopeHeader } from '../src/renderer/src/components/TargetsScopeHeader'
import { DashboardView } from '../src/renderer/src/components/DashboardView'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { scopeConfigured } from '../src/renderer/src/lib/scope'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'
import { installTimelineBridge } from './helpers/timeline-bridge'

const noop = (): void => {}
type Rules = { targets: string[]; excludeTargets: string[] }
const CASES: Array<{ name: string; rules: Rules; configured: boolean }> = [
  { name: 'allow-only', rules: { targets: ['a.test'], excludeTargets: [] }, configured: true },
  { name: 'exclude-only', rules: { targets: [], excludeTargets: ['x.test', 'y.test'] }, configured: false },
  { name: 'both', rules: { targets: ['a.test'], excludeTargets: ['x.test'] }, configured: true },
  { name: 'neither', rules: { targets: [], excludeTargets: [] }, configured: false }
]

function install(rules: Rules): void {
  const named: Record<string, Record<string, unknown>> = {
    config: { get: vi.fn(async () => ({ engagement: { id: 'ENG-1' }, operator: { name: 'op' }, scope: rules })) },
    events: {
      aggregateTargets: async () => [], getCount: async () => 0, onNewBatch: () => noop
    },
    chain: { length: async () => 0, anchors: async () => [] },
    capture: { health: async () => ({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    scope: { getObservationCount: async () => 0, isConfigured: async () => rules.targets.length > 0, getLastRecompute: async () => null },
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

describe('the one predicate', () => {
  it.each(CASES)('$name → configured is $configured', ({ rules, configured }) => {
    expect(scopeConfigured(rules)).toBe(configured)
  })
  it('a missing scope is not configured', () => {
    expect(scopeConfigured(undefined)).toBe(false)
    expect(scopeConfigured(null)).toBe(false)
  })
})

describe('the Targets & Scope header', () => {
  it.each(CASES)('$name', async ({ rules, configured }) => {
    install(rules)
    render(<I18nProvider><TargetsScopeHeader page="targets" onNavigate={noop} onOpenSettings={noop} /></I18nProvider>)
    const title = configured ? 'Scope rules are set' : 'Scope is not set'
    expect(await screen.findByText(title)).toBeTruthy()
    const strip = screen.getByTestId('scope-context')
    if (configured) expect(strip.textContent).toContain(`Allowed ${rules.targets.length}`)
    else expect(strip.textContent).not.toContain('Allowed')
    // Exclusions are reported as a fact whenever there are any, configured or not.
    if (rules.excludeTargets.length > 0 || configured) {
      expect(screen.getByTestId('scope-context-exclude').textContent).toBe(`Excluded ${rules.excludeTargets.length}`)
    } else {
      expect(screen.queryByTestId('scope-context-exclude')).toBeNull()
    }
    // Not configured has no observation count to give.
    await waitFor(() => expect(screen.getByTestId('tab-count-scope').textContent).toBe(configured ? '0' : '—'))
  })
})

describe('the dashboard project summary', () => {
  it.each(CASES)('$name', async ({ rules, configured }) => {
    install(rules)
    render(<I18nProvider><DashboardView onNavigate={noop} projectName="p" /></I18nProvider>)
    const state = await screen.findByTestId('dashboard-scope-state')
    expect(state.textContent).toBe(configured
      ? (rules.excludeTargets.length ? `${rules.targets.length} allowed / ${rules.excludeTargets.length} excluded` : `${rules.targets.length} allowed`)
      : 'Not set')
  })
})

describe('the Targets page', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('with exclusions only, no target is called in scope', async () => {
    installTimelineBridge()
    const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
    r.config = { get: vi.fn(async () => ({ scope: { targets: [], excludeTargets: ['x.test'] } })), save: async () => true }
    r.events.aggregateTargets = async () => [
      { target: 'a.test', eventCount: 1, firstSeen: 1, lastSeen: 1 },
      { target: 'x.test', eventCount: 1, firstSeen: 1, lastSeen: 1 }
    ]
    render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(screen.getAllByText('Not set')).toHaveLength(2))
    expect(screen.queryByText('In scope')).toBeNull()
  })
})
