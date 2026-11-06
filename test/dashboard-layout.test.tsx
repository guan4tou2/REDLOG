// @vitest-environment jsdom
//
// Spec 069 T019 (dashboard): the page's header, the record summary with its
// chain / local-only / anchor breakdown, the network card and the project
// summary. Each block says only what its data says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DashboardView } from '../src/renderer/src/components/DashboardView'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

const noop = (): void => {}
interface Opts {
  chained?: number; logged?: number; chainLen?: number
  anchors?: Array<{ createdAt: number; status: string }>
  targets?: string[]; ip?: Record<string, unknown> | null
}

function install(o: Opts = {}): void {
  const counts = { chained: o.chained ?? 120, logged: o.logged ?? 30 }
  const named: Record<string, Record<string, unknown>> = {
    capture: { health: async () => ({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    events: { getCount: async (tier?: string) => (tier === 'logged' ? counts.logged : counts.chained), onNewBatch: () => noop },
    chain: { length: async () => o.chainLen ?? counts.chained, anchors: async () => o.anchors ?? [] },
    project: { active: async () => ({ createdAt: Date.now() - 60_000 }) },
    ip: { getStatus: async () => (o.ip === undefined ? { externalIP: '203.0.113.18', internalIP: '10.0.2.15', ipSafety: 'unknown', lastCheck: Date.now() } : o.ip), onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    loot: { getCount: async () => 0 },
    config: { get: async () => ({ engagement: { id: 'ENG-042' }, operator: { name: 'op-01' }, scope: { targets: o.targets ?? [], warnOnViolation: true } }) },
    pivots: { getActive: async () => [], onChange: () => noop }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}
const show = (onNavigate: (v: string) => void = noop): void => {
  render(<I18nProvider><DashboardView onNavigate={onNavigate} projectName="Acme external" /></I18nProvider>)
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); _resetCaptureHealth(); _resetIssues() })
afterEach(() => { cleanup(); window.localStorage.clear() })

describe('dashboard header', () => {
  it('names the page, says how to read every status, and carries no status of its own', async () => {
    install(); show()
    const header = await screen.findByTestId('dashboard-header')
    expect(header.querySelector('h1')?.textContent).toBe('Dashboard')
    expect(header.textContent).toContain('OVERVIEW')
    expect(screen.getByTestId('dashboard-freshness-note').textContent).toBe('Each status is as its source last reported it')
  })
})

describe('record summary', () => {
  it('splits the total into the chain and local-only rows', async () => {
    install({ chained: 1960, logged: 224 }); show()
    await waitFor(() => expect(screen.getByTestId('dashboard-record-total').textContent).toBe('2184'))
    const text = screen.getByTestId('dashboard-record-summary').textContent ?? ''
    expect(text).toContain('In the chain (hashed) 1960')
    expect(text).toContain('Local only (not in the chain hash) 224')
    expect(text).not.toMatch(/buffer|waiting for chain/i)
  })

  it('opens the activity page', async () => {
    const go = vi.fn(); install(); show(go)
    fireEvent.click(await screen.findByTestId('dashboard-open-activity'))
    expect(go).toHaveBeenCalledWith('search')
  })

  it('says "none yet" with no anchor, and never "anchored" for one that is only submitted', async () => {
    install(); show()
    await waitFor(() => expect(screen.getByTestId('dashboard-anchor').textContent).toBe('none yet'))
    cleanup(); install({ anchors: [{ createdAt: Date.now() - 3_600_000, status: 'pending' }] }); show()
    await waitFor(() => expect(screen.getByTestId('dashboard-anchor').textContent).toMatch(/^submitted, not yet confirmed/))
    expect(screen.getByTestId('dashboard-anchor').textContent).not.toMatch(/^confirmed/)
  })

  it('reports each anchor state as its own', async () => {
    for (const [status, text] of [['complete', /^confirmed ·/], ['partial', /^partly confirmed/], ['failed', /^failed/]] as const) {
      install({ anchors: [{ createdAt: Date.now() - 60_000, status }] }); show()
      await waitFor(() => expect(screen.getByTestId('dashboard-anchor').textContent).toMatch(text))
      cleanup()
    }
  })

  it('keeps the chain-drift warning under the numbers', async () => {
    install({ chained: 100, chainLen: 97 }); show()
    expect((await screen.findByTestId('dashboard-record-warning')).textContent).toMatch(/chain 97 ≠ events 100/)
  })
})

describe('network card', () => {
  it('shows the title, the safety state, and the external and internal address as rows', async () => {
    install(); show()
    const card = await screen.findByTestId('ip-status-card')
    await waitFor(() => expect(card.textContent).toContain('203.0.113.18'))
    expect(card.textContent).toContain('Current outbound connection')
    expect(card.textContent).toContain('Unknown IP')
    expect(card.textContent).toContain('10.0.2.15')
  })
})

describe('project summary', () => {
  it('flags a scope that has not been set, and opens the scope page', async () => {
    const go = vi.fn(); install({ targets: [] }); show(go)
    const state = await screen.findByTestId('dashboard-scope-state')
    expect(state.textContent).toBe('Not set')
    fireEvent.click(screen.getByTestId('dashboard-view-scope'))
    expect(go).toHaveBeenCalledWith('targets')
  })

  it('shows the rule count once a scope exists, and the project identity', async () => {
    install({ targets: ['10.10.0.0/16', 'acme.test'] }); show()
    expect((await screen.findByTestId('dashboard-scope-state')).textContent).toMatch(/^2 targets/)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Acme external')
    expect(text).toContain('ENG-042')
    expect(text).toContain('op-01')
  })
})
