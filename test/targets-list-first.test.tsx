// @vitest-environment jsdom
//
// Targets & scope, the list first (03-targets prototype). The page used to
// stack six layers of explanation above the first target; what it says now is
// the rules themselves and the targets, and the one fact the captions held
// that nothing else says: being listed is not being authorised.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { TargetsScopeHeader } from '../src/renderer/src/components/TargetsScopeHeader'
import { ScopeStatus } from '../src/renderer/src/components/ScopeStatus'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { installTimelineBridge } from './helpers/timeline-bridge'

type Redlog = Record<string, Record<string, unknown>>
const redlog = (): Redlog => (window as unknown as { redlog: Redlog }).redlog
const noop = (): void => {}

type Row = { target: string; eventCount: number; firstSeen: number; lastSeen: number }
function installTargets(rows: Row[], scope: { targets: string[]; excludeTargets: string[] } | Error = { targets: [], excludeTargets: [] }): void {
  installTimelineBridge()
  const r = redlog()
  r.events.aggregateTargets = async () => rows
  r.config = { get: vi.fn(async () => { if (scope instanceof Error) throw scope; return { engagement: { id: 'eng' }, scope } }), save: async () => true }
}
const mountTargets = (): void => {
  render(<I18nProvider><FilterProvider><TargetView onOpenInTimeline={noop} /></FilterProvider></I18nProvider>)
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks() })

describe('G1: no explanation layers above the list', () => {
  it('the header is the heading, the tabs and the rules, with no caption under the heading', async () => {
    installTargets([])
    redlog().scope = { getObservationCount: async () => 0 }
    render(<I18nProvider><TargetsScopeHeader page="targets" onNavigate={noop} onOpenSettings={noop} /></I18nProvider>)
    await screen.findByTestId('scope-context')
    expect(screen.queryByText(/Targets seen in recorded events/)).toBeNull()
  })

  it('the list has no panel title, caption, sort note, footer count or hint, and says listing is not authorisation', async () => {
    installTargets([{ target: '10.0.0.1', eventCount: 2, firstSeen: 1, lastSeen: 2 }])
    mountTargets()
    await screen.findByText('10.0.0.1')
    for (const gone of [/Observed targets/, /Gathered from the project/, /Most recent activity first/, /Showing \d+ of \d+ targets/, /Target status follows/]) {
      expect(screen.queryByText(gone), String(gone)).toBeNull()
    }
    expect(screen.getByTestId('targets-not-authorised').textContent).toBe('Listed is not authorised')
  })

  it('the observations tab has no record-integrity card and does not read the chain for it', async () => {
    const length = vi.fn(async () => 7)
    ;(window as unknown as { redlog: unknown }).redlog = {
      scope: {
        getObservations: async () => ({ rows: [{ id: 'v1', target: 'v1.example', command: 'curl v1.example', timestamp: 1, distance: 'excluded', judged: 'live', cleared: false }], truncated: false }),
        getObservationCount: async () => 1, isConfigured: async () => true, getLastRecompute: async () => null
      },
      chain: { length },
      events: { onNewBatch: () => noop }
    }
    render(<I18nProvider><ScopeStatus /></I18nProvider>)
    await screen.findByText('v1.example')
    expect(screen.queryByText('Record integrity')).toBeNull()
    expect(screen.queryByTestId('scope-chain-entries')).toBeNull()
    await waitFor(() => expect(length).not.toHaveBeenCalled())
  })
})
