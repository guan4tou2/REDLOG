// @vitest-environment jsdom
//
// With no project open, shells that are still running stay reachable in a
// strip under the picker. That they are not recorded is said once, by each
// pane's own line (TerminalView's gap line, "terminal.noProjectRecording"),
// not a second time as a heading over the strip.

import { useEffect, useState } from 'react'
import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import App from '../src/renderer/src/App'

const h = vi.hoisted(() => {
  const page = (name: string) => function StandIn(): JSX.Element {
    const [n, setN] = useState(0)
    useEffect(() => { setN(1) }, [])
    return <div data-testid={`${name}-page`} data-n={n} />
  }
  return { page }
})

vi.mock('../src/renderer/src/components/TargetView', () => ({ TargetView: h.page('targets') }))
vi.mock('../src/renderer/src/components/ScopeStatus', () => ({ ScopeStatus: h.page('scope') }))
vi.mock('../src/renderer/src/components/LootPanel', () => ({ LootPanel: h.page('loot') }))
vi.mock('../src/renderer/src/components/BookmarksView', () => ({ BookmarksView: h.page('bookmarks') }))
vi.mock('../src/renderer/src/components/ScreenshotsView', () => ({ ScreenshotsView: h.page('screenshots') }))
vi.mock('../src/renderer/src/components/HttpHistoryPanel', () => ({ HttpHistoryPanel: h.page('http_history') }))
vi.mock('../src/renderer/src/components/Timeline', () => ({ default: () => <div data-testid="timeline-standin" /> }))
vi.mock('../src/renderer/src/components/Sidebar', () => ({
  default: ({ onNavigate }: { onNavigate: (v: string) => void }) => (
    <nav>{['dashboard', 'timeline', 'targets', 'scope', 'loot', 'bookmarks', 'screenshots', 'http_history'].map((v) =>
      <button key={v} data-testid={`nav-${v}`} onClick={() => onNavigate(v)}>{v}</button>)}</nav>
  )
}))
vi.mock('../src/renderer/src/components/CommandPalette', () => ({
  CommandPalette: ({ onOpenEvent, onProjectClosed }: { onOpenEvent: (id: string, ts: number) => void; onProjectClosed: () => void }) => (
    <div>
      <button data-testid="palette-open-event" onClick={() => onOpenEvent('e1', 1)}>open event</button>
      <button data-testid="palette-close-project" onClick={onProjectClosed}>close project</button>
    </div>
  )
}))
vi.mock('../src/renderer/src/components/ProjectPicker', () => ({
  default: ({ onProjectOpen }: { onProjectOpen: (p: { id: string; name: string }) => void }) =>
    <button data-testid="picker-open-p2" onClick={() => onProjectOpen({ id: 'p2', name: 'Other' })}>open</button>
}))
vi.mock('../src/renderer/src/components/StatusBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ReplayDrawer', () => ({ ReplayDrawer: () => null }))
vi.mock('../src/renderer/src/components/EventMarker', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/RecordingWorkspace', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ExportMenu', () => ({ ExportMenu: () => null }))
vi.mock('../src/renderer/src/components/TargetsScopeHeader', () => ({ TargetsScopeHeader: () => null }))
vi.mock('../src/renderer/src/components/EvidenceHeader', () => ({ EvidenceHeader: () => null }))
vi.mock('../src/renderer/src/components/FilterBar', () => ({ FilterBar: () => null }))
vi.mock('../src/renderer/src/components/DashboardView', () => ({ DashboardView: () => <div data-testid="dashboard-standin" />, LaunchBrowserButton: () => null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: ({ allowNew }: { allowNew?: boolean }) => <div data-testid="terminal-standin" data-allow-new={String(allowNew)} /> }))
vi.mock('../src/renderer/src/components/Settings', () => ({ default: () => null }))
vi.mock('../src/renderer/src/lib/FilterContext', () => ({ FilterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../src/renderer/src/hooks/useVisibility', () => ({ useVisibility: () => ({ visibility: { tierChip: null }, firstRunActive: false }) }))
vi.mock('../src/renderer/src/hooks/useAppShortcuts', () => ({ useAppShortcuts: () => {} }))


const unsub = (): void => {}
beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    app: { takeUpdateOutcome: async () => null, onUpdateOutcomeReady: () => unsub },
    project: { active: async () => null },
    events: { getCount: async () => 0 },
    marker: { onShortcut: () => unsub },
    screenshot: { onShortcutResult: () => unsub },
    recording: { get: async () => false, onChange: () => unsub },
    terminal: { list: async () => [{ id: 't1', pid: 1, recording: false, castTruncated: false, paused: false, recordingReason: 'no-project' }] }
  }
})
afterEach(() => { cleanup(); window.localStorage.clear() })

it('keeps surviving shells under the picker without a second "not recorded" heading over them', async () => {
  render(<I18nProvider><App /></I18nProvider>)
  const strip = await screen.findByTestId('picker-terminals')
  await screen.findByTestId('terminal-standin')
  expect(screen.getByTestId('terminal-standin').dataset.allowNew).toBe('false')
  expect(strip.textContent).not.toContain('No project is open')
})
