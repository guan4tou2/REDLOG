// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { DashboardView } from '../src/renderer/src/components/DashboardView'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues, snapshotIssues } from '../src/renderer/src/lib/issues'
import { toast } from '../src/renderer/src/components/Toast'

// A failed capture-health read used to leave the last verdict on screen as if
// it were current: the status bar kept its colour, the dashboard card kept its
// headline. After a failure the screen has to say what it can no longer say.

vi.mock('../src/renderer/src/components/Toast', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/Toast')>()),
  toast: vi.fn()
}))

const snap = (verdict: 'healthy' | 'partial' | 'dark'): CaptureHealthInfo => ({
  verdict, hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(),
  dbErrorTotal: 0, dbErrorFirstAt: null
} as unknown as CaptureHealthInfo)

const noop = (): void => {}
let health: ReturnType<typeof vi.fn>
let batch: () => void

// Anything the component does not care about answers with an empty value; the
// two calls under test are `capture.health` and `events.onNewBatch`.
function installBridge(): void {
  const named: Record<string, Record<string, unknown>> = {
    capture: { health },
    events: { getCount: async () => 0, onNewBatch: (cb: () => void) => { batch = cb; return noop } },
    chain: { length: async () => 0, anchors: async () => [] },
    project: { active: async () => ({ createdAt: Date.now() - 60_000 }) },
    ip: { getStatus: async () => null, onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    loot: { getCount: async () => 0 },
    config: { get: async () => ({}) }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target
      ? target[fn]
      : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

const show = (ui: React.ReactElement): void => { render(<I18nProvider>{ui}</I18nProvider>) }
// The bar's own poll is a 30 s interval; run its callback instead of waiting.
const tickStatusBar = async (): Promise<void> => {
  const poll = vi.mocked(setInterval).mock.calls.filter((c) => c[1] === 30_000).at(-1)?.[0] as (() => void) | undefined
  if (!poll) throw new Error('no 30 s poll was scheduled')
  await act(async () => { poll() })
}
const rec = (): HTMLElement => screen.getByTestId('status-bar-recording')

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('redlog-locale', 'en')
  vi.mocked(toast).mockClear()
  _resetCaptureHealth(); _resetIssues()
  health = vi.fn()
  installBridge()
  vi.spyOn(globalThis, 'setInterval')
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetCaptureHealth(); _resetIssues() })

describe('StatusBar capture dot', () => {
  it('after a failed read it stops showing the old verdict and says when it was last confirmed', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValue(new Error('ipc'))
    show(<StatusBar />)
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('healthy'))
    expect(rec().querySelector('span')!.className).toContain('bg-red-500')

    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('aria-label')).toMatch(/Last confirmed healthy \d{1,2}:\d{2}.*; current state unknown/))
    const dot = rec().querySelector('span')!.className
    expect(dot).not.toMatch(/bg-red-500|bg-amber-500|animate-pulse/)
    expect(rec().getAttribute('data-capture')).toBe('unknown')
  })

  it('names the verdict that was last confirmed, not always "healthy"', async () => {
    health.mockResolvedValueOnce(snap('dark')).mockRejectedValue(new Error('ipc'))
    show(<StatusBar />)
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('dark'))
    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('aria-label')).toMatch(/Last confirmed dark /))
  })

  it('says so when it has never been confirmed', async () => {
    health.mockRejectedValue(new Error('ipc'))
    show(<StatusBar />)
    await waitFor(() => expect(rec().getAttribute('aria-label')).toMatch(/never confirmed/i))
    expect(rec().querySelector('span')!.className).not.toMatch(/bg-red-500|bg-amber-500/)
  })

  it('a failed read after a healthy one raises no issue and fires no toast', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValue(new Error('ipc'))
    show(<StatusBar />)
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('healthy'))
    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('unknown'))
    expect(snapshotIssues().find((i) => i.id === 'capture')).toBeUndefined()
    expect(toast).not.toHaveBeenCalled()
  })

  it('a failed read does not clear a capture issue a real read raised', async () => {
    health.mockResolvedValueOnce(snap('partial')).mockRejectedValue(new Error('ipc'))
    show(<StatusBar />)
    await waitFor(() => expect(snapshotIssues().some((i) => i.id === 'capture')).toBe(true))
    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('unknown'))
    expect(snapshotIssues().some((i) => i.id === 'capture')).toBe(true)
  })

  it('a good read after the failure restores the verdict', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValueOnce(new Error('ipc')).mockResolvedValue(snap('healthy'))
    show(<StatusBar />)
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('healthy'))
    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('unknown'))
    await tickStatusBar()
    await waitFor(() => expect(rec().getAttribute('data-capture')).toBe('healthy'))
    expect(rec().getAttribute('aria-label')).not.toMatch(/unknown/)
  })
})

describe('Dashboard capture card', () => {
  const card = (): HTMLElement => screen.getByTestId('capture-unknown')

  it('after a failed read it replaces the old headline with the last confirmed time', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValue(new Error('ipc'))
    show(<DashboardView onNavigate={noop} projectName="p" />)
    await screen.findByText('Capture is working')
    expect(screen.queryByTestId('capture-unknown')).toBeNull()

    await act(async () => { batch() })
    await waitFor(() => expect(card().textContent).toMatch(/Last confirmed healthy \d{1,2}:\d{2}.*; current state unknown/))
    expect(screen.queryByText('Capture is working')).toBeNull()
  })

  it('says so when the first read failed and nothing was ever confirmed', async () => {
    health.mockRejectedValue(new Error('ipc'))
    show(<DashboardView onNavigate={noop} projectName="p" />)
    await waitFor(() => expect(card().textContent).toMatch(/never confirmed/i))
  })

  it('goes back to the verdict once a read succeeds', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValueOnce(new Error('ipc')).mockResolvedValue(snap('healthy'))
    show(<DashboardView onNavigate={noop} projectName="p" />)
    await screen.findByText('Capture is working')
    await act(async () => { batch() })
    await waitFor(() => card())
    await act(async () => { batch() })
    await screen.findByText('Capture is working')
    expect(screen.queryByTestId('capture-unknown')).toBeNull()
  })
})

describe('Dashboard capture card (Stitch 08)', () => {
  it('offers a retry beside the unknown headline, and it reads again', async () => {
    health.mockResolvedValueOnce(snap('healthy')).mockRejectedValue(new Error('ipc'))
    show(<DashboardView onNavigate={noop} projectName="p" />)
    await screen.findByText('Capture is working')
    await act(async () => { batch() })
    await screen.findByTestId('capture-unknown')
    const calls = health.mock.calls.length
    health.mockResolvedValue(snap('healthy'))
    await act(async () => { screen.getByTestId('capture-unknown-retry').click() })
    await waitFor(() => expect(health.mock.calls.length).toBeGreaterThan(calls))
  })
})
