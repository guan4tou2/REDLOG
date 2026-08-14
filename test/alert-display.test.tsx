// @vitest-environment jsdom
//
// The last hop of the alert path: a verdict is computed (ip-monitor) and now it
// has to be VISIBLE. `renderer-smoke.test.tsx` only proves these components
// mount; nothing asserted that an EXPOSED verdict actually turns the HUD red,
// or that `overlay.flashOnExposed: false` really silences the flash. Since
// RedLog never blocks, a verdict that fails to reach the operator's eye is the
// whole defence failing — so each display option gets an assertion here.
//
// Colours come from lib/hud (jsdom normalises them to rgb()); sizes come from
// the scale/emphasis maths in OverlayApp.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'
import IPStatusCard from '../src/renderer/src/components/IPStatusCard'

const RED = 'rgb(215, 95, 99)'    // HUD.red   — exposed
const GREEN = 'rgb(94, 207, 156)' // HUD.green — safe
const CYAN = 'rgb(63, 199, 214)'  // HUD.cyan  — the resting frame

const unsub = (): void => {}

interface Overrides {
  ipSafety?: 'safe' | 'exposed' | 'unknown'
  externalIP?: string | null
  internalIP?: string | null
  error?: string | null
  overlay?: Record<string, unknown>
}

function installBridge(o: Overrides = {}): void {
  const status = {
    externalIP: o.externalIP === undefined ? '203.0.113.7' : o.externalIP,
    internalIP: o.internalIP === undefined ? '10.0.0.2' : o.internalIP,
    ipSafety: o.ipSafety ?? 'safe',
    lastCheck: 1_700_000_000_000,
    error: o.error ?? null,
    settling: false
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    ip: { getStatus: async () => status, onStatus: () => unsub },
    config: { get: async () => ({ overlay: o.overlay ?? {} }) },
    recording: { get: async () => true, onChange: () => unsub },
    pivots: { getActive: async () => [], onChange: () => unsub },
    overlay: {
      onInteractive: () => unsub,
      setExpanded: () => {},
      hide: () => {},
      quickMark: () => {},
      instantMark: async () => ({ ok: true }),
      autosize: () => {}
    }
  }
}

function renderOverlay(o: Overrides = {}): HTMLElement {
  installBridge(o)
  const { container } = render(<I18nProvider><OverlayApp /></I18nProvider>)
  return container
}

/** The neon frame div — the element whose background carries the verdict.
 *  Structure: container ▸ padding wrapper ▸ frame ▸ inset panel. */
function frameOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild?.firstElementChild as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('HUD — the verdict is visible at a glance', () => {
  it('EXPOSED turns the frame red and labels it EXPOSED', async () => {
    const c = renderOverlay({ ipSafety: 'exposed' })
    expect(await screen.findByText('EXPOSED')).toBeTruthy()
    await waitFor(() => expect(frameOf(c).style.background).toBe(RED))
  })

  it('SAFE keeps the resting cyan frame and labels it SAFE', async () => {
    const c = renderOverlay({ ipSafety: 'safe' })
    expect(await screen.findByText('SAFE')).toBeTruthy()
    expect(frameOf(c).style.background).toBe(CYAN)
  })

  it('UNKNOWN is its own amber state, not a silent pass', async () => {
    renderOverlay({ ipSafety: 'unknown' })
    expect(await screen.findByText('IP?')).toBeTruthy()
  })

  it('shows the external IP that the verdict was computed from', async () => {
    renderOverlay({ ipSafety: 'exposed', externalIP: '198.51.100.4' })
    expect(await screen.findAllByText('198.51.100.4')).toHaveLength(1)
  })

  it('renders an em dash rather than a stale address when there is no reading yet', async () => {
    renderOverlay({ externalIP: null, internalIP: null })
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThan(0))
  })
})

describe('overlay.flashOnExposed', () => {
  it('default (unset) flashes the frame while EXPOSED', async () => {
    const c = renderOverlay({ ipSafety: 'exposed' })
    await waitFor(() => expect(frameOf(c).style.animation).toContain('alarm'))
  })

  it('true flashes', async () => {
    const c = renderOverlay({ ipSafety: 'exposed', overlay: { flashOnExposed: true } })
    await waitFor(() => expect(frameOf(c).style.animation).toContain('alarm'))
  })

  it('false keeps the red frame but stops the flashing', async () => {
    const c = renderOverlay({ ipSafety: 'exposed', overlay: { flashOnExposed: false } })
    await waitFor(() => expect(frameOf(c).style.background).toBe(RED))
    expect(frameOf(c).style.animation).not.toContain('alarm')
  })

  it('never flashes while SAFE, whatever the setting', async () => {
    const c = renderOverlay({ ipSafety: 'safe', overlay: { flashOnExposed: true } })
    await waitFor(() => expect(frameOf(c).style.background).toBe(CYAN))
    expect(frameOf(c).style.animation).not.toContain('alarm')
  })
})

describe('overlay.scale + overlay.emphasizeExternalIp', () => {
  /** Font size of the compact-bar external IP, in px. */
  async function ipFontSize(o: Overrides): Promise<number> {
    renderOverlay(o)
    const el = await screen.findByText('203.0.113.7')
    return parseFloat((el as HTMLElement).style.fontSize)
  }

  it('1.0 (default) renders the external IP at the base 12px', async () => {
    expect(await ipFontSize({})).toBe(12)
  })

  it('0.85 / 1.25 / 1.5 scale the type proportionally', async () => {
    expect(await ipFontSize({ overlay: { scale: 0.85 } })).toBe(10.2)
    cleanup()
    expect(await ipFontSize({ overlay: { scale: 1.25 } })).toBe(15)
    cleanup()
    expect(await ipFontSize({ overlay: { scale: 1.5 } })).toBe(18)
  })

  it('clamps a rogue config to the 0.75–2.0 band', async () => {
    expect(await ipFontSize({ overlay: { scale: 99 } })).toBe(24)      // 12 × 2
    cleanup()
    expect(await ipFontSize({ overlay: { scale: 0.01 } })).toBe(9)     // 12 × 0.75
  })

  it('a zero or negative scale is ignored, not clamped to the floor', async () => {
    expect(await ipFontSize({ overlay: { scale: 0 } })).toBe(12)
    cleanup()
    expect(await ipFontSize({ overlay: { scale: -1 } })).toBe(12)
  })

  it('emphasizeExternalIp bumps ONLY the IP by a further 1.4×', async () => {
    expect(await ipFontSize({ overlay: { emphasizeExternalIp: true } })).toBe(16.8)
    cleanup()
    // compounds with scale
    expect(await ipFontSize({ overlay: { emphasizeExternalIp: true, scale: 1.5 } })).toBe(25.2)
  })
})

describe('overlay.passThrough / passThroughOpacity', () => {
  /** Dimmed chrome: the REC pill. The external IP must never be dimmed. */
  function recOpacity(): string {
    return (screen.getByText('REC').parentElement as HTMLElement).style.opacity
  }

  it('off by default — nothing is dimmed', async () => {
    renderOverlay({})
    await screen.findByText('REC')
    expect(recOpacity()).toBe('')
  })

  it('on dims the chrome to the default 0.4', async () => {
    renderOverlay({ overlay: { passThrough: true } })
    await waitFor(() => expect(recOpacity()).toBe('0.4'))
  })

  it('honours a custom opacity', async () => {
    renderOverlay({ overlay: { passThrough: true, passThroughOpacity: 0.15 } })
    await waitFor(() => expect(recOpacity()).toBe('0.15'))
  })

  it('ignores a 0 opacity — an invisible HUD would be worse than none', async () => {
    renderOverlay({ overlay: { passThrough: true, passThroughOpacity: 0 } })
    await waitFor(() => expect(recOpacity()).toBe('0.4'))
  })

  it('leaves the external IP at full opacity — the point of the HUD stays readable', async () => {
    renderOverlay({ overlay: { passThrough: true } })
    const ip = await screen.findByText('203.0.113.7')
    expect((ip.parentElement?.parentElement as HTMLElement).style.opacity).toBe('')
  })
})

describe('overlay.showMarkButton', () => {
  async function expand(): Promise<void> {
    fireEvent.click(await screen.findByLabelText('Show details'))
  }

  it('default (unset) shows both mark buttons in the expanded pane', async () => {
    renderOverlay({})
    await expand()
    expect(await screen.findByText(/QUICK/)).toBeTruthy()
    expect(screen.getByText(/DETAIL/)).toBeTruthy()
  })

  it('false hides them, leaving the keep-open toggle', async () => {
    renderOverlay({ overlay: { showMarkButton: false } })
    await expand()
    await waitFor(() => expect(screen.getByLabelText(/keep open/i)).toBeTruthy())
    expect(screen.queryByText(/QUICK/)).toBeNull()
    expect(screen.queryByText(/DETAIL/)).toBeNull()
  })
})

describe('HUD expanded pane', () => {
  it('spells the verdict out in words, not just colour', async () => {
    renderOverlay({ ipSafety: 'exposed' })
    fireEvent.click(await screen.findByLabelText('Show details'))
    expect(await screen.findByText('Exposed IP — Not Protected')).toBeTruthy()
  })

  it('tells an operator how to fix an UNKNOWN verdict', async () => {
    renderOverlay({ ipSafety: 'unknown' })
    fireEvent.click(await screen.findByLabelText('Show details'))
    expect(await screen.findByText(/Set Safe IPs \/ Exposed IPs in Settings/)).toBeTruthy()
  })

  it('surfaces a provider error instead of pretending the reading is fresh', async () => {
    renderOverlay({ error: 'All IP providers failed' })
    fireEvent.click(await screen.findByLabelText('Show details'))
    expect(await screen.findByText('All IP providers failed')).toBeTruthy()
  })
})

describe('IPStatusCard — the same verdict on the dashboard', () => {
  beforeEach(() => installBridge())

  function renderCard(o: Overrides = {}): HTMLElement {
    installBridge(o)
    const { container } = render(<I18nProvider><IPStatusCard /></I18nProvider>)
    return container
  }

  it('shows a placeholder until the first reading lands', () => {
    const c = renderCard()
    expect(c.textContent).toContain('Checking IP')
  })

  it('SAFE: green dot, no warning copy', async () => {
    const c = renderCard({ ipSafety: 'safe' })
    expect(await screen.findByText('Safe IP')).toBeTruthy()
    expect(c.querySelector('.bg-green-500')).toBeTruthy()
    expect(c.textContent).not.toContain('EXPOSED')
  })

  it('EXPOSED: red pulsing dot + the "check your VPN" hint', async () => {
    const c = renderCard({ ipSafety: 'exposed' })
    expect(await screen.findByText('Exposed IP')).toBeTruthy()
    expect(c.querySelector('.bg-red-500.animate-pulse')).toBeTruthy()
    expect(c.textContent).toContain('traffic is not going through your VPN/tunnel')
  })

  it('UNKNOWN: yellow dot + the "configure the lists" hint', async () => {
    const c = renderCard({ ipSafety: 'unknown' })
    expect(await screen.findByText('Unknown IP')).toBeTruthy()
    expect(c.querySelector('.bg-yellow-500')).toBeTruthy()
    expect(c.textContent).toContain('Settings ▸ Network')
  })

  it('shows both addresses so an operator can tell egress from LAN', async () => {
    renderCard({ externalIP: '198.51.100.4', internalIP: '192.168.1.20' })
    expect(await screen.findByText('198.51.100.4')).toBeTruthy()
    expect(screen.getByText('192.168.1.20')).toBeTruthy()
  })

  it('renders the provider error alongside the last known verdict', async () => {
    const c = renderCard({ error: 'All IP providers failed' })
    await screen.findByText('Safe IP')
    expect(c.textContent).toContain('All IP providers failed')
  })
})
