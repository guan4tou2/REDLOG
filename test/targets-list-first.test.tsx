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

describe('G2: a target is one line', () => {
  // 2026-11-18 12:00 local: "today" is fixed so the date rule is testable.
  const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime()
  const at = (d: number, h: number, m: number, s = 0): number => new Date(2026, 10, d, h, m, s).getTime()
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }) })
  afterEach(() => { vi.useRealTimers() })

  const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('[role="option"]') as HTMLElement
  const visible = (el: Element | null): string => (el?.querySelector('[aria-hidden="true"]')?.textContent ?? '')

  it('each of the four relations has its own shape and its own word', async () => {
    installTargets([
      { target: 'in.test', eventCount: 1, firstSeen: NOW, lastSeen: NOW },
      { target: 'out.test', eventCount: 1, firstSeen: NOW, lastSeen: NOW }
    ], { targets: ['in.test'], excludeTargets: [] })
    mountTargets()
    await waitFor(() => expect(rowOf('out.test').textContent).toContain('Out of scope'))
    const relation = (name: string): Element | null => rowOf(name).querySelector('[data-testid="target-relation"]')
    expect(relation('in.test')?.textContent).toBe('●In scope')
    expect(relation('out.test')?.textContent).toBe('▲Out of scope')
    cleanup()

    installTargets([{ target: 'any.test', eventCount: 1, firstSeen: NOW, lastSeen: NOW }])
    mountTargets()
    await screen.findByText('any.test')
    await waitFor(() => expect(relation('any.test')?.textContent).toBe('–Not set'))
    cleanup()

    installTargets([{ target: 'any.test', eventCount: 1, firstSeen: NOW, lastSeen: NOW }], new Error('no config'))
    mountTargets()
    await screen.findByTestId('targets-scope-failed')
    expect(relation('any.test')?.textContent).toBe('○Scope unknown')
  })

  it('first and last seen carry the date when it is not today, and only the time today', async () => {
    installTargets([
      { target: 'today.test', eventCount: 4, firstSeen: at(18, 9, 1, 2), lastSeen: at(18, 11, 30, 5) },
      { target: 'days.test', eventCount: 12, firstSeen: at(17, 22, 4), lastSeen: at(18, 9, 31, 7) },
      { target: 'once.test', eventCount: 1, firstSeen: at(12, 23, 41), lastSeen: at(12, 23, 50) }
    ])
    mountTargets()
    await screen.findByText('today.test')
    const seen = (name: string): string => visible(rowOf(name).querySelector('[data-testid="target-seen"]'))
    expect(seen('today.test')).toBe('09:01:02 – 11:30:05')
    expect(seen('days.test')).toBe('11-17 22:04 – 09:31:07')
    expect(seen('once.test')).toBe('11-12 23:41 – 23:50')
  })

  it('labels are not repeated on every row: the count is a bare number with its words in the title', async () => {
    installTargets([{ target: 'a.test', eventCount: 12, firstSeen: NOW, lastSeen: NOW }])
    mountTargets()
    await screen.findByText('a.test')
    const row = rowOf('a.test')
    const count = row.querySelector('[data-testid="target-count"]') as HTMLElement
    expect(visible(count)).toBe('12')
    expect(count.getAttribute('title')).toBe('12 events')
    const shown = Array.from(row.querySelectorAll('[aria-hidden="true"]')).map((n) => n.textContent).join(' ')
    expect(shown).not.toMatch(/First|Last|events/)
  })

  it('says "working now" on the row of the target being worked on', async () => {
    installTargets([{ target: 'a.test', eventCount: 1, firstSeen: NOW, lastSeen: NOW }])
    redlog().targetContext = { get: async () => 'a.test', onChange: () => noop }
    mountTargets()
    await waitFor(() => expect(rowOf('a.test').textContent).toContain('Working now'))
  })
})

describe('G2: an observation carries its date when it is not today', () => {
  const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime()
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }) })
  afterEach(() => { vi.useRealTimers() })

  it('today is the time alone, another day has its date', async () => {
    const row = (id: string, ts: number): Record<string, unknown> => ({ id, target: `${id}.example`, command: 'curl', timestamp: ts, distance: 'excluded', judged: 'live', cleared: false })
    ;(window as unknown as { redlog: unknown }).redlog = {
      scope: {
        getObservations: async () => ({ rows: [row('today', new Date(2026, 10, 18, 9, 1, 2).getTime()), row('before', new Date(2026, 10, 16, 22, 4).getTime())], truncated: false }),
        getObservationCount: async () => 2, isConfigured: async () => true, getLastRecompute: async () => null
      },
      events: { onNewBatch: () => noop }
    }
    render(<I18nProvider><ScopeStatus /></I18nProvider>)
    await screen.findByText('today.example')
    expect(screen.getAllByTestId('scope-observation-time').map((n) => n.textContent?.trim())).toEqual(['09:01:02', '11-16 22:04'])
  })
})

describe('G3: the relation filters carry their numbers', () => {
  const rows: Row[] = [
    { target: 'in.test', eventCount: 1, firstSeen: 1, lastSeen: 3 },
    { target: 'out-a.test', eventCount: 1, firstSeen: 1, lastSeen: 2 },
    { target: 'out-b.test', eventCount: 1, firstSeen: 1, lastSeen: 1 }
  ]
  const filters = (): Record<string, { count: string; disabled: boolean }> => Object.fromEntries(
    Array.from(screen.getByRole('group', { name: 'Scope filter' }).querySelectorAll('button')).map((b) => [
      b.dataset.filter, { count: b.querySelector('[data-testid="targets-filter-count"]')?.textContent ?? '', disabled: b.disabled }
    ]))

  it('counts the whole project for each relation', async () => {
    installTargets(rows, { targets: ['in.test'], excludeTargets: [] })
    mountTargets()
    await waitFor(() => expect(filters().in_scope.count).toBe('1'))
    expect(filters()).toEqual({
      all: { count: '3', disabled: false }, in_scope: { count: '1', disabled: false }, out_scope: { count: '2', disabled: false }
    })
  })

  it('with no rule declared, or none readable, in and out are a dash and stay disabled', async () => {
    installTargets(rows)
    mountTargets()
    await screen.findByText('in.test')
    expect(filters()).toEqual({
      all: { count: '3', disabled: false }, in_scope: { count: '—', disabled: true }, out_scope: { count: '—', disabled: true }
    })
    cleanup()
    installTargets(rows, new Error('no config'))
    mountTargets()
    await screen.findByTestId('targets-scope-failed')
    expect(filters().out_scope).toEqual({ count: '—', disabled: true })
  })
})
