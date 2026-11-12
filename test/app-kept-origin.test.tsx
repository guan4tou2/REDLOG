// @vitest-environment jsdom
//
// #692: jumping from a page to the Timeline and coming back remounted the page,
// so its search text, filters, open row and scroll were gone. App now keeps
// that one origin mounted and hidden for the length of the Timeline visit.
// The pages themselves are stand-ins here: what is under test is whether App
// unmounts them, and a mount counter plus an uncontrolled input answer that.

import { useEffect, useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import App from '../src/renderer/src/App'
import { keepOnJump, keptView, restoreScroll } from '../src/renderer/src/lib/keptOrigin'

const h = vi.hoisted(() => {
  const mounts: Record<string, number> = {}
  const flags = { modalOpen: false }
  type Jump = (a: unknown, b: unknown) => void
  // Called at render time, after the imports below have resolved.
  const page = (name: string) => function StandIn(props: { onOpenInTimeline?: Jump; active?: boolean }): JSX.Element {
    const [crash, setCrash] = useState(false)
    useEffect(() => { mounts[name] = (mounts[name] ?? 0) + 1 }, [])
    useEffect(() => {
      const boom = (): void => setCrash(true)
      window.addEventListener(`test:crash-${name}`, boom)
      return () => window.removeEventListener(`test:crash-${name}`, boom)
    }, [])
    if (crash) throw new Error(`${name} crashed while hidden`)
    return (
      <div data-testid={`${name}-page`} data-active={String(props.active)}>
        <input data-testid={`${name}-input`} aria-label={name} />
        {props.onOpenInTimeline && <button data-testid={`${name}-jump`} onClick={() => props.onOpenInTimeline?.('e1', 1)}>jump</button>}
        {name === 'screenshots' && flags.modalOpen && <div role="dialog" aria-modal="true" />}
      </div>
    )
  }
  return { mounts, flags, page }
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
vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Settings', () => ({ default: () => null }))
vi.mock('../src/renderer/src/lib/FilterContext', () => ({ FilterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../src/renderer/src/hooks/useVisibility', () => ({ useVisibility: () => ({ visibility: { tierChip: null }, firstRunActive: false }) }))
vi.mock('../src/renderer/src/hooks/useAppShortcuts', () => ({ useAppShortcuts: () => {} }))

const unsub = (): void => {}
function installBridge(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
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

const viewRoot = (): HTMLElement => screen.getByTestId('view-root')
const slot = (id: string): HTMLElement | null => document.querySelector(`[data-origin="${id}"]`)
function back(): void {
  fireEvent.click(within(screen.getByTestId('timeline-return')).getByRole('button'))
}

// The six pages the issue names. HTTP history is kept too: it takes `active`
// and stops contributing the export scope while hidden (see lib/keptOrigin.ts).
const ORIGINS: Array<{ id: string; jump: string }> = [
  { id: 'targets', jump: 'targets-jump' },
  { id: 'scope', jump: 'scope-jump' },
  { id: 'loot', jump: 'loot-jump' },
  { id: 'bookmarks', jump: 'bookmarks-jump' },
  // Screenshots has no locate control of its own; the palette is its way there.
  { id: 'screenshots', jump: 'palette-open-event' },
  { id: 'http_history', jump: 'http_history-jump' }
]

describe('App keeps the Timeline jump origin mounted (#692)', () => {
  beforeEach(() => {
    installBridge()
    window.localStorage.clear()
    for (const k of Object.keys(h.mounts)) delete h.mounts[k]
    h.flags.modalOpen = false
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  for (const { id, jump } of ORIGINS) {
    it(`${id} → Timeline → back returns to the same instance, input intact`, async () => {
      await mountApp()
      fireEvent.click(screen.getByTestId(`nav-${id}`))
      const input = (await screen.findByTestId(`${id}-input`)) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'needle' } })
      expect(h.mounts[id]).toBe(1)

      fireEvent.click(screen.getByTestId(jump))
      expect(viewRoot().getAttribute('data-view')).toBe('timeline')
      expect(screen.getByTestId('timeline-standin')).toBeTruthy()
      // Still mounted, but neither visible nor reachable by focus or click.
      const kept = slot(id)!
      expect(kept).toBeTruthy()
      expect(kept.hidden).toBe(true)
      expect(kept.hasAttribute('inert')).toBe(true)

      back()
      expect(viewRoot().getAttribute('data-view')).toBe(id)
      expect(h.mounts[id]).toBe(1)
      expect((screen.getByTestId(`${id}-input`) as HTMLInputElement).value).toBe('needle')
      expect(screen.getByTestId(`${id}-input`)).toBe(input)
      expect(slot(id)!.hidden).toBe(false)
      expect(slot(id)!.hasAttribute('inert')).toBe(false)
    })
  }

  it('HTTP history is told it is inactive while hidden behind the Timeline, active again on return', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-http_history'))
    await screen.findByTestId('http_history-input')
    expect(screen.getByTestId('http_history-page').getAttribute('data-active')).toBe('true')
    fireEvent.click(screen.getByTestId('http_history-jump'))
    expect(slot('http_history')!.hidden).toBe(true)
    expect(screen.getByTestId('http_history-page').getAttribute('data-active')).toBe('false')
    back()
    expect(screen.getByTestId('http_history-page').getAttribute('data-active')).toBe('true')
    expect(h.mounts.http_history).toBe(1)
  })

  it('navigating anywhere else from the Timeline drops the kept origin', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-loot'))
    fireEvent.click(screen.getByTestId('loot-jump'))
    expect(slot('loot')).toBeTruthy()
    fireEvent.click(screen.getByTestId('nav-targets'))
    expect(slot('loot')).toBeNull()
    expect(screen.queryByTestId('loot-page')).toBeNull()
    fireEvent.click(screen.getByTestId('nav-loot'))
    expect(h.mounts.loot).toBe(2)
  })

  it('another jump from the Timeline drops it too', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-scope'))
    fireEvent.click(screen.getByTestId('scope-jump'))
    expect(slot('scope')).toBeTruthy()
    fireEvent.click(screen.getByTestId('palette-open-event'))
    expect(viewRoot().getAttribute('data-view')).toBe('timeline')
    expect(slot('scope')).toBeNull()
  })

  it('a project change drops it', async () => {
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-bookmarks'))
    fireEvent.click(screen.getByTestId('bookmarks-jump'))
    expect(slot('bookmarks')).toBeTruthy()
    fireEvent.click(screen.getByTestId('palette-close-project'))
    fireEvent.click(await screen.findByTestId('picker-open-p2'))
    await screen.findByTestId('view-root')
    expect(slot('bookmarks')).toBeNull()
    expect(screen.queryByTestId('bookmarks-page')).toBeNull()
  })

  it('a crash in the hidden origin stays in its own boundary; the Timeline keeps running', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-targets'))
    fireEvent.click(screen.getByTestId('targets-jump'))
    act(() => { window.dispatchEvent(new Event('test:crash-targets')) })
    expect(screen.getByTestId('timeline-standin')).toBeTruthy()
    expect(screen.getByTestId('timeline-return')).toBeTruthy()
  })

  it('a page with a dialog open is not kept, so the dialog cannot hold keys on the Timeline', async () => {
    h.flags.modalOpen = true
    await mountApp()
    fireEvent.click(screen.getByTestId('nav-screenshots'))
    fireEvent.click(screen.getByTestId('palette-open-event'))
    expect(slot('screenshots')).toBeNull()
    back()
    expect(h.mounts.screenshots).toBe(2)
  })
})

describe('keptOrigin helpers', () => {
  const kept = { view: 'loot', projectId: 'p1', scroll: [] }

  // Contract changed with the return trail: the origin is kept for the whole
  // trail (Timeline, then Activity), not only while on the Timeline.
  it('keeps only while the trail in force starts at that origin, in that project', () => {
    expect(keptView({ view: 'timeline', trail: ['loot', 'timeline'], projectId: 'p1', kept })).toBe('loot')
    expect(keptView({ view: 'search', trail: ['loot', 'timeline', 'search'], projectId: 'p1', kept })).toBe('loot')
    expect(keptView({ view: 'loot', trail: [], projectId: 'p1', kept })).toBeNull()
    expect(keptView({ view: 'timeline', trail: [], projectId: 'p1', kept })).toBeNull()
    expect(keptView({ view: 'timeline', trail: ['targets', 'timeline'], projectId: 'p1', kept })).toBeNull()
    expect(keptView({ view: 'search', trail: ['timeline', 'search'], projectId: 'p1', kept })).toBeNull()
    // A trail whose last step is not the page on screen is over.
    expect(keptView({ view: 'terminal', trail: ['loot', 'timeline'], projectId: 'p1', kept })).toBeNull()
    expect(keptView({ view: 'timeline', trail: ['loot', 'timeline'], projectId: 'p2', kept })).toBeNull()
    expect(keptView({ view: 'timeline', trail: ['loot', 'timeline'], projectId: 'p1', kept: null })).toBeNull()
  })

  it('does not keep pages outside the list, or with no root to measure', () => {
    const root = document.createElement('div')
    for (const v of ['dashboard', 'terminal', 'settings', 'search', 'timeline']) expect(keepOnJump(v, 'p1', root)).toBeNull()
    expect(keepOnJump('loot', 'p1', null)).toBeNull()
    expect(keepOnJump('loot', undefined, root)).toBeNull()
  })

  function scroller(top: number, height = 2000): HTMLElement {
    const el = document.createElement('div')
    let value = top
    Object.defineProperty(el, 'scrollTop', { get: () => value, set: (v: number) => { value = v }, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true })
    return el
  }

  it('records scroll offsets at the jump and puts them back on return', () => {
    const root = document.createElement('div')
    const list = scroller(900)
    const still = scroller(0)
    root.append(list, still)
    document.body.append(root)
    const k = keepOnJump('targets', 'p1', root)!
    expect(k.scroll).toEqual([{ el: list, top: 900 }])
    list.scrollTop = 0 // what display:none does to it in Chromium
    restoreScroll(k.scroll)()
    expect(list.scrollTop).toBe(900)
    root.remove()
  })

  it('waits for content that is not tall enough yet, and gives up when the operator takes over', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length })
    let height = 300
    const el = document.createElement('div')
    let value = 0
    Object.defineProperty(el, 'scrollTop', { get: () => value, set: (v: number) => { value = Math.min(v, Math.max(0, height - 400)) }, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true })
    document.body.append(el)
    restoreScroll([{ el, top: 700 }])
    expect(el.scrollTop).toBe(0)
    height = 1200
    frames.shift()!(0)
    expect(el.scrollTop).toBe(700)

    value = 0
    height = 300
    restoreScroll([{ el, top: 500 }])
    window.dispatchEvent(new Event('wheel'))
    height = 1200
    frames.splice(0).forEach((f) => f(0))
    expect(el.scrollTop).toBe(0)
    el.remove()
  })

  it('does not keep a page with a dialog open', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    expect(keepOnJump('screenshots', 'p1', root)).toBeNull()
  })
})
