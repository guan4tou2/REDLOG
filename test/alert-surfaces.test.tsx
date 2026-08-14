// @vitest-environment jsdom
//
// The two alert surfaces `alert-display` does not cover, plus the live-update
// path that feeds all of them.
//
//   StatusBar    — the always-visible strip: IP verdict, scope violation count,
//                  and the recording/capture-health dot. It is the only alert
//                  surface on screen while the operator is on the Timeline.
//   ScopeStatus  — the Scope & Evidence view: configured/not-set, the violation
//                  list, and the "all in scope" green state.
//   HUD live     — flipping a setting in Settings has to reach the already-open
//                  overlay window through its IPC subscriptions, not just on the
//                  next launch.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { ScopeStatus } from '../src/renderer/src/components/ScopeStatus'
import OverlayApp from '../src/renderer/src/OverlayApp'

const unsub = (): void => {}
type Violation = { target: string; command: string; timestamp: number }

interface Opts {
  ipSafety?: 'safe' | 'exposed' | 'unknown'
  externalIP?: string | null
  violations?: Violation[]
  scopeConfigured?: boolean
  recording?: boolean
  captureVerdict?: 'healthy' | 'partial' | 'dark'
  lootCount?: number
}

function installBridge(o: Opts = {}): void {
  const violations = o.violations ?? []
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    project: { active: async () => ({ id: 'p1', name: 'Proj', createdAt: Date.now() - 65_000 }) },
    ip: {
      getStatus: async () => ({
        externalIP: o.externalIP === undefined ? '203.0.113.7' : o.externalIP,
        internalIP: '10.0.0.2',
        ipSafety: o.ipSafety ?? 'safe',
        lastCheck: Date.now(),
        error: null,
        settling: false
      }),
      onStatus: () => unsub
    },
    events: { getCount: async () => 42, onNew: () => unsub },
    loot: { getCount: async () => o.lootCount ?? 0 },
    scope: {
      getViolationCount: async () => violations.length,
      getViolations: async () => violations,
      isConfigured: async () => o.scopeConfigured ?? true
    },
    chain: { length: async () => 128 },
    recording: { get: async () => o.recording ?? true, toggle: async () => true, onChange: () => unsub },
    overlay: { isVisible: async () => true, onVisibilityChanged: () => unsub, toggle: () => {} },
    capture: { health: async () => ({ verdict: o.captureVerdict ?? 'healthy' }) },
    quickmarks: { create: async () => ({ id: 'q1' }) },
    data: { exportViolations: async () => '/tmp/violations.json' },
    pivots: { getActive: async () => [], onChange: () => unsub },
    config: { get: async () => ({ overlay: {} }) }
  }
}

function renderWith(ui: React.ReactElement, o: Opts = {}): HTMLElement {
  installBridge(o)
  return render(<I18nProvider>{ui}</I18nProvider>).container
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('StatusBar — the always-visible verdict', () => {
  it('SAFE: green dot and the external IP alongside it', async () => {
    const c = renderWith(<StatusBar />, { ipSafety: 'safe' })
    expect(await screen.findByText('SAFE')).toBeTruthy()
    expect(c.querySelector('.bg-emerald-500')).toBeTruthy()
    expect(screen.getByText('203.0.113.7')).toBeTruthy()
  })

  it('EXPOSED: red dot and label', async () => {
    const c = renderWith(<StatusBar />, { ipSafety: 'exposed' })
    expect(await screen.findByText('EXPOSED')).toBeTruthy()
    expect(c.querySelector('.bg-red-500')).toBeTruthy()
  })

  it('UNKNOWN: amber, never quietly green', async () => {
    const c = renderWith(<StatusBar />, { ipSafety: 'unknown' })
    expect(await screen.findByText('IP?')).toBeTruthy()
    expect(c.querySelector('.bg-amber-500')).toBeTruthy()
  })

  it('omits the address when there is no reading yet', async () => {
    renderWith(<StatusBar />, { ipSafety: 'unknown', externalIP: null })
    await screen.findByText('IP?')
    expect(screen.queryByText('203.0.113.7')).toBeNull()
  })

  it('scope clean: SCOPE OK', async () => {
    renderWith(<StatusBar />, { violations: [] })
    expect(await screen.findByText('SCOPE OK')).toBeTruthy()
  })

  it('scope violations: the count is on the strip', async () => {
    const v = (n: number): Violation[] =>
      Array.from({ length: n }, (_, i) => ({ target: `t${i}`, command: 'curl', timestamp: 1 }))
    renderWith(<StatusBar />, { violations: v(3) })
    expect(await screen.findByText('SCOPE 3')).toBeTruthy()
    expect(screen.queryByText('SCOPE OK')).toBeNull()
  })

  it('recording on + healthy capture: pulsing red REC', async () => {
    renderWith(<StatusBar />, { recording: true, captureVerdict: 'healthy' })
    const btn = await screen.findByTestId('status-bar-recording')
    await waitFor(() => expect(btn.dataset.capture).toBe('healthy'))
    expect(btn.dataset.recording).toBe('on')
    expect(btn.querySelector('.bg-red-500.animate-pulse-slow')).toBeTruthy()
  })

  it('recording on but capture DARK: amber, because "REC" alone would be a lie', async () => {
    renderWith(<StatusBar />, { recording: true, captureVerdict: 'dark' })
    const btn = await screen.findByTestId('status-bar-recording')
    await waitFor(() => expect(btn.dataset.capture).toBe('dark'))
    expect(btn.querySelector('.bg-amber-500')).toBeTruthy()
    expect(btn.querySelector('.animate-pulse-slow')).toBeNull()
  })

  it('capture PARTIAL: amber and still pulsing', async () => {
    renderWith(<StatusBar />, { captureVerdict: 'partial' })
    const btn = await screen.findByTestId('status-bar-recording')
    await waitFor(() => expect(btn.dataset.capture).toBe('partial'))
    expect(btn.querySelector('.bg-amber-500.animate-pulse-slow')).toBeTruthy()
  })

  it('paused: grey PAUSED with a resume hint', async () => {
    renderWith(<StatusBar />, { recording: false })
    const btn = await screen.findByTestId('status-bar-recording')
    await waitFor(() => expect(btn.dataset.recording).toBe('off'))
    expect(screen.getByText('PAUSED')).toBeTruthy()
    expect(btn.getAttribute('title')).toBe('Click to resume recording')
  })

  it('loot count is highlighted only when there is loot', async () => {
    const c = renderWith(<StatusBar />, { lootCount: 0 })
    expect(await screen.findByText('0 loot')).toBeTruthy()
    expect(c.querySelectorAll('.text-amber-400\\/80')).toHaveLength(0)
    cleanup()
    renderWith(<StatusBar />, { lootCount: 2 })
    expect(await screen.findByText('2 loot')).toBeTruthy()
  })
})

describe('ScopeStatus — the Scope & Evidence view', () => {
  const violation = (target: string): Violation => ({ target, command: `curl ${target}`, timestamp: 1_700_000_000_000 })

  it('no scope set: NOT SET plus the hint that fixes it', async () => {
    renderWith(<ScopeStatus />, { scopeConfigured: false, violations: [] })
    expect(await screen.findByText('NOT SET')).toBeTruthy()
    expect(screen.getByText('Add scope targets in Settings → Scope tab')).toBeTruthy()
  })

  it('scope set and clean: ACTIVE + all-in-scope, and no export button', async () => {
    renderWith(<ScopeStatus />, { scopeConfigured: true, violations: [] })
    expect(await screen.findByText('ACTIVE')).toBeTruthy()
    expect(screen.getByText('All commands within scope')).toBeTruthy()
    expect(screen.queryByText('Export')).toBeNull()
  })

  it('violations: count, per-row target and command, and the export button', async () => {
    renderWith(<ScopeStatus />, { violations: [violation('vpn.example.com'), violation('dc01.app.example.com')] })
    expect(await screen.findByText('2 scope violation(s) detected')).toBeTruthy()
    expect(screen.getByText('vpn.example.com')).toBeTruthy()
    expect(screen.getByText('curl dc01.app.example.com')).toBeTruthy()
    expect(screen.getByText('Export')).toBeTruthy()
    expect(screen.queryByText('All commands within scope')).toBeNull()
  })

  it('caps the recent list at 10 rows without losing the count', async () => {
    const many = Array.from({ length: 14 }, (_, i) => violation(`host${i}.example.com`))
    const c = renderWith(<ScopeStatus />, { violations: many })
    expect(await screen.findByText('14 scope violation(s) detected')).toBeTruthy()
    expect(c.querySelectorAll('.bg-red-900\\/20')).toHaveLength(10)
  })

  it('shows the chain length so the evidence log is visible next to the violations', async () => {
    renderWith(<ScopeStatus />, { violations: [] })
    expect(await screen.findByText('128 entries')).toBeTruthy()
  })
})

describe('HUD live-update — a Settings change reaches the open overlay', () => {
  /** Bridge whose config subscriptions hand their callbacks back to the test. */
  function installLiveBridge(): Record<string, (...a: never[]) => void> {
    installBridge()
    const cbs: Record<string, (...a: never[]) => void> = {}
    const capture = (name: string) => (cb: (...a: never[]) => void) => { cbs[name] = cb; return unsub }
    ;(window as unknown as { redlog: { config: unknown } }).redlog.config = {
      get: async () => ({ overlay: { flashOnExposed: true, scale: 1.0, showMarkButton: true } }),
      onShowMark: capture('showMark'),
      onFlashExposed: capture('flashExposed'),
      onScale: capture('scale'),
      onEmphasizeIp: capture('emphasizeIp'),
      onPassThrough: capture('passThrough')
    }
    return cbs
  }

  async function renderLive(): Promise<Record<string, (...a: never[]) => void>> {
    const cbs = installLiveBridge()
    render(<I18nProvider><OverlayApp /></I18nProvider>)
    await screen.findByText('203.0.113.7')
    return cbs
  }

  it('subscribes to all five overlay settings', async () => {
    const cbs = await renderLive()
    expect(Object.keys(cbs).sort()).toEqual(['emphasizeIp', 'flashExposed', 'passThrough', 'scale', 'showMark'])
  })

  it('turning the flash off stops it without a restart', async () => {
    const cbs = await renderLive()
    installBridge({ ipSafety: 'exposed' })   // not re-read; the HUD is already mounted
    cbs.flashExposed(false as never)
    await waitFor(() => {
      const frame = document.body.querySelector('div > div') as HTMLElement
      expect(frame.style.animation).not.toContain('alarm')
    })
  })

  it('a scale change re-renders at the new size', async () => {
    const cbs = await renderLive()
    cbs.scale(1.5 as never)
    await waitFor(() => {
      expect(parseFloat((screen.getByText('203.0.113.7') as HTMLElement).style.fontSize)).toBe(18)
    })
  })

  it('emphasis can be switched on live', async () => {
    const cbs = await renderLive()
    cbs.emphasizeIp(true as never)
    await waitFor(() => {
      expect(parseFloat((screen.getByText('203.0.113.7') as HTMLElement).style.fontSize)).toBe(16.8)
    })
  })

  it('pass-through arrives with its opacity in one message', async () => {
    const cbs = await renderLive()
    cbs.passThrough(true as never, 0.2 as never)
    await waitFor(() => {
      expect((screen.getByText('REC').parentElement as HTMLElement).style.opacity).toBe('0.2')
    })
  })

  it('a 0 opacity in a live message is ignored, same as in the config', async () => {
    const cbs = await renderLive()
    cbs.passThrough(true as never, 0 as never)
    await waitFor(() => {
      expect((screen.getByText('REC').parentElement as HTMLElement).style.opacity).toBe('0.4')
    })
  })

  it('hiding the mark buttons takes effect live', async () => {
    const cbs = await renderLive()
    fireEvent.click(screen.getByLabelText('Show details'))
    expect(await screen.findByText(/QUICK/)).toBeTruthy()   // present before the change
    cbs.showMark(false as never)
    await waitFor(() => expect(screen.queryByText(/QUICK/)).toBeNull())
  })
})
