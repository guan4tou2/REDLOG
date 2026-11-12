// @vitest-environment jsdom
//
// The capture issue named the dashboard as where to deal with it — the page
// its own issue list is drawn on — so from there "Open" went nowhere. It now
// leads to the failing source's settings when exactly one source is failing,
// and the dashboard list offers no link that would land where it already is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { DashboardIssues } from '../src/renderer/src/components/DashboardIssues'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues, raiseIssue, snapshotIssues } from '../src/renderer/src/lib/issues'
import { captureIssueView } from '../src/renderer/src/lib/captureIssue'

type Src = { id: string; state: 'ready' | 'unset' | 'off' | 'error'; lastEventAt: number | null }
const ready = (id: string): Src => ({ id, state: 'ready', lastEventAt: 1 })
const failed = (id: string): Src => ({ id, state: 'error', lastEventAt: 1 })

describe('captureIssueView', () => {
  it('leads to the one failing source\'s own row', () => {
    expect(captureIssueView({ verdict: 'partial', sources: [ready('terminal'), failed('screenshot')] }))
      .toBe('settings/captureControl?source=screenshot')
    expect(captureIssueView({ verdict: 'partial', sources: [failed('agent-claude-code')] }))
      .toBe('settings/captureControl?source=agent-claude-code')
  })

  it('sends the two core sources to the pages that configure them', () => {
    expect(captureIssueView({ verdict: 'partial', sources: [failed('terminal')] })).toBe('settings/hooks')
    expect(captureIssueView({ verdict: 'partial', sources: [ready('mitmproxy')], managedHttpProxy: { state: 'failed' } }))
      .toBe('settings/browser')
    // The proxy and its row are one failure, not two.
    expect(captureIssueView({ verdict: 'partial', sources: [failed('mitmproxy')], managedHttpProxy: { state: 'failed' } }))
      .toBe('settings/browser')
  })

  it('stays on the dashboard when no single source is the answer', () => {
    expect(captureIssueView({ verdict: 'partial', sources: [failed('screenshot'), failed('clipboard')] })).toBe('dashboard')
    expect(captureIssueView({ verdict: 'partial', sources: [failed('screenshot')], managedHttpProxy: { state: 'failed' } })).toBe('dashboard')
    // Dark is a write or chain failure, or nothing wired — not one source.
    expect(captureIssueView({ verdict: 'dark', sources: [failed('screenshot')] })).toBe('dashboard')
  })
})

const noop = (): void => {}
function installBridge(sources: Src[]): void {
  const named: Record<string, Record<string, unknown>> = {
    capture: { health: async () => ({ verdict: 'partial', hasRecorded: true, sources, lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    events: { getCount: async () => 5, onNewBatch: () => noop },
    ip: { getStatus: async () => ({ safety: 'safe' }), onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    project: { active: async () => ({ createdAt: Date.now() - 60_000 }) },
    chain: { length: async () => 0, anchors: async () => [] }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

describe('the capture issue the status bar raises', () => {
  beforeEach(() => {
    window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en')
    _resetCaptureHealth(); _resetIssues()
  })
  afterEach(() => { cleanup() })

  it('names the failing source\'s settings row, and the bar\'s counter goes there', async () => {
    installBridge([ready('terminal'), failed('screenshot')])
    const heard = vi.fn()
    const listen = (e: Event): void => heard((e as CustomEvent<string>).detail)
    window.addEventListener('redlog:navigate', listen)
    render(<I18nProvider><StatusBar /></I18nProvider>)
    await waitFor(() => expect(snapshotIssues().find((i) => i.id === 'capture')?.view).toBe('settings/captureControl?source=screenshot'))
    fireEvent.click(await screen.findByTestId('status-bar-attention'))
    expect(heard).toHaveBeenCalledWith('settings/captureControl?source=screenshot')
    window.removeEventListener('redlog:navigate', listen)
  })

  it('names the dashboard when two sources are failing', async () => {
    installBridge([failed('clipboard'), failed('screenshot')])
    render(<I18nProvider><StatusBar /></I18nProvider>)
    await waitFor(() => expect(snapshotIssues().find((i) => i.id === 'capture')?.view).toBe('dashboard'))
  })
})

describe('the store hands out a changed destination', () => {
  afterEach(() => { _resetIssues() })

  it('re-raising with the same title and a new view is a new snapshot', () => {
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture partial', view: 'dashboard' })
    expect(snapshotIssues()[0].view).toBe('dashboard')
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture partial', view: 'settings/hooks' })
    expect(snapshotIssues()[0].view).toBe('settings/hooks')
  })
})

describe('the dashboard issue list', () => {
  afterEach(() => { cleanup(); _resetIssues() })
  const show = (onNavigate: (v: string) => void): void => {
    window.localStorage.setItem('redlog-locale', 'en')
    render(<I18nProvider><DashboardIssues onNavigate={onNavigate} /></I18nProvider>)
  }

  it('offers no link to the dashboard it is drawn on', () => {
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture partial', view: 'dashboard' })
    show(noop)
    expect(screen.getByTestId('dashboard-issue-capture')).toBeTruthy()
    expect(screen.queryByText('Open')).toBeNull()
  })

  it('opens the failing source\'s row when there is one', () => {
    const onNavigate = vi.fn()
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture partial', view: 'settings/captureControl?source=screenshot' })
    show(onNavigate)
    fireEvent.click(screen.getByText('Open'))
    expect(onNavigate).toHaveBeenCalledWith('settings/captureControl?source=screenshot')
  })
})
