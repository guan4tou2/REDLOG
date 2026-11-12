// @vitest-environment jsdom
//
// The way back from a jump is the steps the operator took — origin › Timeline
// › Activity — shown where the single back link was, each earlier step a
// button. The origin stays mounted (hidden, inert) for the whole trail, so
// going back to it from Activity finds it as it was. Pages are stand-ins: what
// is under test is App's routing, kept page and bar.

import { useEffect, useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import App from '../src/renderer/src/App'
import { currentTrail, trailToActivity, trailToTimeline } from '../src/renderer/src/lib/returnTrail'

const h = vi.hoisted(() => {
  const mounts: Record<string, number> = {}
  const flags = { modalOpen: false }
  const seen: { timelineFocus?: string; workspaceActive?: boolean } = {}
  type Jump = (a: unknown, b: unknown) => void
  const page = (name: string) => function StandIn(props: { onOpenInTimeline?: Jump; active?: boolean }): JSX.Element {
    const [open, setOpen] = useState(false)
    useEffect(() => { mounts[name] = (mounts[name] ?? 0) + 1 }, [])
    return (
      <div data-testid={`${name}-page`} data-active={String(props.active)}>
        <input data-testid={`${name}-input`} aria-label={name} />
        <button data-testid={`${name}-row`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>row</button>
        {props.onOpenInTimeline && <button data-testid={`${name}-jump`} onClick={() => props.onOpenInTimeline?.('e1', 1)}>jump</button>}
        {flags.modalOpen && <div role="dialog" aria-modal="true" />}
      </div>
    )
  }
  return { mounts, flags, seen, page }
})

vi.mock('../src/renderer/src/components/TargetView', () => ({ TargetView: h.page('targets') }))
vi.mock('../src/renderer/src/components/ScopeStatus', () => ({ ScopeStatus: h.page('scope') }))
vi.mock('../src/renderer/src/components/LootPanel', () => ({ LootPanel: h.page('loot') }))
vi.mock('../src/renderer/src/components/BookmarksView', () => ({ BookmarksView: h.page('bookmarks') }))
vi.mock('../src/renderer/src/components/ScreenshotsView', () => ({ ScreenshotsView: h.page('screenshots') }))
vi.mock('../src/renderer/src/components/HttpHistoryPanel', () => ({ HttpHistoryPanel: h.page('http_history') }))
vi.mock('../src/renderer/src/components/Timeline', () => ({
  default: ({ focusEventId, onOpenInActivity }: { focusEventId?: string; onOpenInActivity: (id: string, ts: number) => void }) => {
    h.seen.timelineFocus = focusEventId
    return <div data-testid="timeline-standin"><button data-testid="timeline-to-activity" onClick={() => onOpenInActivity('ev-left', 7)}>activity</button></div>
  }
}))
vi.mock('../src/renderer/src/components/RecordingWorkspace', () => ({
  default: ({ active, onOpenInTimeline }: { active: boolean; onOpenInTimeline: (id: string, ts: number) => void }) => {
    h.seen.workspaceActive = active
    return <div data-testid="workspace-standin"><button data-testid="activity-to-timeline" onClick={() => onOpenInTimeline('ev-other', 9)}>timeline</button></div>
  }
}))
vi.mock('../src/renderer/src/components/Sidebar', () => ({
  default: ({ onNavigate }: { onNavigate: (v: string) => void }) => (
    <nav>{['dashboard', 'timeline', 'targets', 'scope', 'loot', 'bookmarks', 'screenshots', 'http_history', 'search'].map((v) =>
      <button key={v} data-testid={`nav-${v}`} onClick={() => onNavigate(v)}>{v}</button>)}</nav>
  )
}))
vi.mock('../src/renderer/src/components/CommandPalette', () => ({
  CommandPalette: ({ onOpenEvent }: { onOpenEvent: (id: string, ts: number) => void }) => (
    <button data-testid="palette-open-event" onClick={() => onOpenEvent('e1', 1)}>open event</button>
  )
}))
vi.mock('../src/renderer/src/components/ProjectPicker', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/StatusBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ReplayDrawer', () => ({ ReplayDrawer: () => null }))
vi.mock('../src/renderer/src/components/EventMarker', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ExportMenu', () => ({ ExportMenu: () => null }))
vi.mock('../src/renderer/src/components/TargetsScopeHeader', () => ({ TargetsScopeHeader: () => null }))
vi.mock('../src/renderer/src/components/EvidenceHeader', () => ({ EvidenceHeader: () => null }))
vi.mock('../src/renderer/src/components/FilterBar', () => ({ FilterBar: () => null }))
vi.mock('../src/renderer/src/components/DashboardView', () => ({ DashboardView: h.page('dashboard'), LaunchBrowserButton: () => null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Settings', () => ({ default: () => null }))
vi.mock('../src/renderer/src/lib/FilterContext', () => ({ FilterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../src/renderer/src/hooks/useVisibility', () => ({ useVisibility: () => ({ visibility: { tierChip: null }, firstRunActive: false }) }))
vi.mock('../src/renderer/src/hooks/useAppShortcuts', () => ({ useAppShortcuts: () => {} }))

const unsub = (): void => {}
function installBridge(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'linux',
    app: { takeUpdateOutcome: async () => null, onUpdateOutcomeReady: () => unsub },
    project: { active: async () => ({ id: 'p1', name: 'Proj' }) },
    events: { getCount: async () => 0 },
    marker: { onShortcut: () => unsub },
    screenshot: { onShortcutResult: () => unsub },
    recording: { get: async () => true, onChange: () => unsub },
    terminal: { list: async () => [] }
  }
}

async function mountApp(): Promise<void> {
  render(<I18nProvider><App /></I18nProvider>)
  await screen.findByTestId('view-root')
}
const viewOf = (): string | null => screen.getByTestId('view-root').getAttribute('data-view')
const slot = (id: string): HTMLElement | null => document.querySelector(`[data-origin="${id}"]`)
const steps = (bar: string): string[] => [...screen.getByTestId(bar).querySelectorAll('[data-step]')].map((el) => el.getAttribute('data-step') ?? '')
const step = (bar: string, view: string): HTMLElement => screen.getByTestId(bar).querySelector(`button[data-step="${view}"]`) as HTMLElement

/** Loot, with search text and an open row, → Timeline → Activity. */
async function lootToActivity(): Promise<HTMLInputElement> {
  await mountApp()
  fireEvent.click(screen.getByTestId('nav-loot'))
  const input = (await screen.findByTestId('loot-input')) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'needle' } })
  fireEvent.click(screen.getByTestId('loot-row'))
  fireEvent.click(screen.getByTestId('loot-jump'))
  fireEvent.click(screen.getByTestId('timeline-to-activity'))
  expect(viewOf()).toBe('search')
  return input
}

describe('App return trail', () => {
  beforeEach(() => {
    installBridge()
    window.localStorage.setItem('redlog-locale', 'en')
    for (const k of Object.keys(h.mounts)) delete h.mounts[k]
    h.flags.modalOpen = false
    h.seen.timelineFocus = undefined
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

  it('Loot → Timeline → Activity shows the three steps, earlier ones as buttons', async () => {
    await lootToActivity()
    expect(steps('activity-return')).toEqual(['loot', 'timeline', 'search'])
    const bar = screen.getByTestId('activity-return')
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Loot', 'Timeline'])
    expect(bar.querySelector('[aria-current="page"]')?.textContent).toBe('Activity')
  })

  it('the origin stays mounted, hidden and inert on Activity, and is told it is inactive', async () => {
    await lootToActivity()
    expect(slot('loot')).toBeTruthy()
    expect(slot('loot')!.hidden).toBe(true)
    expect(slot('loot')!.hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('loot-page').getAttribute('data-active')).toBe('false')
    expect(h.seen.workspaceActive).toBe(true)
  })

  it('back one step from Activity lands on the Timeline at the event left from, with Loot still the way back', async () => {
    await lootToActivity()
    fireEvent.click(step('activity-return', 'timeline'))
    expect(viewOf()).toBe('timeline')
    expect(h.seen.timelineFocus).toBe('ev-left')
    expect(within(screen.getByTestId('timeline-return')).getByRole('button').textContent).toBe('← Back to Loot')
    expect(slot('loot')!.hidden).toBe(true)
  })

  it('the back key does the same, one step at a time, and reaches the same Loot page', async () => {
    const input = await lootToActivity()
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    expect(viewOf()).toBe('timeline')
    expect(h.seen.timelineFocus).toBe('ev-left')
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    expect(viewOf()).toBe('loot')
    expect(screen.getByTestId('loot-input')).toBe(input)
  })

  it('clicking Loot from Activity returns to the same Loot page, search text and open row intact', async () => {
    const input = await lootToActivity()
    fireEvent.click(step('activity-return', 'loot'))
    expect(viewOf()).toBe('loot')
    expect(h.mounts.loot).toBe(1)
    expect(screen.getByTestId('loot-input')).toBe(input)
    expect(input.value).toBe('needle')
    expect(screen.getByTestId('loot-row').getAttribute('aria-expanded')).toBe('true')
    expect(slot('loot')!.hidden).toBe(false)
    expect(slot('loot')!.hasAttribute('inert')).toBe(false)
    expect(screen.getByTestId('loot-page').getAttribute('data-active')).toBe('true')
    // Arrived: the trail is over.
    expect(screen.queryByTestId('activity-return')).toBeNull()
    expect(screen.queryByTestId('timeline-return')).toBeNull()
  })

  it('sidebar navigation from Activity ends the trail and drops the kept page', async () => {
    await lootToActivity()
    fireEvent.click(screen.getByTestId('nav-dashboard'))
    expect(slot('loot')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-search'))
    expect(screen.queryByTestId('activity-return')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-loot'))
    expect(h.mounts.loot).toBe(2)
  })

  it('a jump from Activity starts a new trail; nothing grows past three steps or repeats a page', async () => {
    await lootToActivity()
    fireEvent.click(screen.getByTestId('activity-to-timeline'))
    expect(viewOf()).toBe('timeline')
    expect(within(screen.getByTestId('timeline-return')).getByRole('button').textContent).toBe('← Back to Activity')
    expect(slot('loot')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-to-activity'))
    // Activity › Timeline › Activity would be a way back to where they are.
    expect(within(screen.getByTestId('activity-return')).getByRole('button').textContent).toBe('← Back to Timeline')
  })

  it('a page with a dialog open is not kept for the trail; going back remounts it', async () => {
    h.flags.modalOpen = true
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-screenshots'))
    fireEvent.click(screen.getByTestId('palette-open-event'))
    fireEvent.click(screen.getByTestId('timeline-to-activity'))
    expect(slot('screenshots')).toBeNull()
    fireEvent.click(step('activity-return', 'screenshots'))
    expect(viewOf()).toBe('screenshots')
    expect(h.mounts.screenshots).toBe(2)
  })

  it('HTTP history is kept for the whole trail and stays inactive while hidden', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-http_history'))
    const input = await screen.findByTestId('http_history-input')
    fireEvent.click(screen.getByTestId('http_history-jump'))
    fireEvent.click(screen.getByTestId('timeline-to-activity'))
    expect(screen.getByTestId('http_history-page').getAttribute('data-active')).toBe('false')
    fireEvent.click(step('activity-return', 'http_history'))
    expect(screen.getByTestId('http_history-input')).toBe(input)
    expect(screen.getByTestId('http_history-page').getAttribute('data-active')).toBe('true')
  })

  it('an origin that cannot be kept is remounted on return, as before', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-dashboard'))
    await screen.findByTestId('dashboard-page')
    expect(h.mounts.dashboard).toBe(1)
    fireEvent.click(screen.getByTestId('palette-open-event'))
    fireEvent.click(screen.getByTestId('timeline-to-activity'))
    expect(steps('activity-return')).toEqual(['dashboard', 'timeline', 'search'])
    fireEvent.click(step('activity-return', 'dashboard'))
    expect(viewOf()).toBe('dashboard')
    expect(h.mounts.dashboard).toBe(2)
  })

  it('one earlier step reads as the old back link, under the old test ids', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-timeline'))
    fireEvent.click(screen.getByTestId('timeline-to-activity'))
    const bar = screen.getByTestId('activity-return')
    expect(within(bar).getAllByRole('button')).toHaveLength(1)
    expect(within(bar).getByRole('button').textContent).toBe('← Back to Timeline')
    fireEvent.click(within(bar).getByRole('button'))
    expect(viewOf()).toBe('timeline')
    expect(screen.queryByTestId('timeline-return')).toBeNull()
  })
})

describe('returnTrail helpers', () => {
  it('builds origin › Timeline › Activity and never more', () => {
    expect(trailToTimeline('loot')).toEqual(['loot', 'timeline'])
    expect(trailToTimeline('timeline')).toEqual([])
    const three = trailToActivity(['loot', 'timeline'], 'timeline')
    expect(three).toEqual(['loot', 'timeline', 'search'])
    expect(trailToActivity([], 'timeline')).toEqual(['timeline', 'search'])
    for (const t of [three, trailToActivity(three, 'search'), trailToActivity(['search', 'timeline'], 'timeline')]) expect(t.length).toBeLessThanOrEqual(3)
  })

  it('a trail is only in force on its last step', () => {
    expect(currentTrail(['loot', 'timeline'], 'timeline')).toEqual(['loot', 'timeline'])
    expect(currentTrail(['loot', 'timeline'], 'terminal')).toEqual([])
    expect(currentTrail(['loot'], 'loot')).toEqual([])
  })
})
