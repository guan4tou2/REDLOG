// @vitest-environment jsdom
//
// What the HUD frame says about its state, in a form a test can read: every
// control is a real, named <button>; the frame marks an exposed address and
// click-through on itself; and the recording and IP states are words, with the
// coloured ticks beside them hidden from assistive tech (colour is never the
// only carrier — UIUX-STANDARD §1, §8).

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'

const unsub = (): void => {}

function install(o: { safety?: 'safe' | 'exposed' | 'unknown'; prefs?: Record<string, unknown> } = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay: {
      autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
      releaseFocus: vi.fn(), addMarker: vi.fn(), quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
    },
    config: { getPrefs: async () => ({ showMarkButton: true, ...o.prefs }) },
    ip: { getStatus: async () => ({ externalIP: '203.0.113.7', internalIP: '10.8.0.3', ipSafety: o.safety ?? 'safe', lastCheck: Date.now(), error: null }), onStatus: () => unsub },
    recording: { get: async () => true, onChange: () => unsub },
    pivots: { getActive: async () => [], onChange: () => unsub }
  }
}
async function mount(): Promise<void> {
  render(<I18nProvider><OverlayApp /></I18nProvider>)
  await act(async () => {})
}
const frame = (): HTMLElement => screen.getByTestId('hud-frame')
const corners = (): HTMLElement[] => screen.getAllByTestId('hud-corner')

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('makes expand, hide and every action a focusable button with a name', async () => {
  install(); await mount()
  for (const name of ['Show details', /Hide HUD/]) {
    const b = screen.getByRole('button', { name })
    expect(b.tagName).toBe('BUTTON')
    expect(b.tabIndex).toBe(0)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  for (const name of ['Hide details', /Add marker/, 'Click-through', /Keep expanded/]) {
    const b = screen.getByRole('button', { name })
    expect(b.tagName).toBe('BUTTON')
    expect(b.tabIndex).toBe(0)
  }
})

it('names the two states in words; the ticks beside them are hidden', async () => {
  install({ safety: 'safe' }); await mount()
  const rec = screen.getByTestId('hud-rec')
  const ip = screen.getByTestId('hud-ip-state')
  expect(rec.textContent).toBe('REC')
  expect(ip.textContent).toBe('SAFE')
  for (const word of [rec, ip]) {
    const tick = word.previousElementSibling as HTMLElement
    expect(tick.textContent).toBe('')
    expect(tick.getAttribute('aria-hidden')).toBe('true')
  }
})

it('marks the frame as exposed, opens the details and keeps the collapse control inert', async () => {
  install({ safety: 'exposed' }); await mount()
  expect(frame().getAttribute('data-state')).toBe('exposed')
  expect(screen.getByTestId('hud-ip-state').textContent).toBe('EXPOSED')
  // the corner marks take the danger colour (#ff4d4f)
  for (const c of corners()) expect(c.style.borderColor).toBe('rgb(255, 77, 79)')
  const collapse = screen.getByRole('button', { name: 'Hide details' })
  expect(collapse.getAttribute('aria-disabled')).toBe('true')
  expect(collapse.getAttribute('title')).toBe('Details stay open while the external IP is exposed')
  fireEvent.click(collapse)
  expect(screen.getByRole('button', { name: 'Hide details' })).toBeTruthy()
  expect(screen.getByTestId('hud-add-marker')).toBeTruthy()
})

it('does not mark a safe frame as exposed, and its collapse control works', async () => {
  install({ safety: 'safe' }); await mount()
  expect(frame().getAttribute('data-state')).toBe('safe')
  for (const c of corners()) expect(c.style.borderColor).toBe('rgb(63, 199, 214)')
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  const collapse = screen.getByRole('button', { name: 'Hide details' })
  expect(collapse.getAttribute('aria-disabled')).toBeNull()
  fireEvent.click(collapse)
  expect(screen.queryByTestId('hud-add-marker')).toBeNull()
})

it('marks click-through on the frame with dashed corners, and leaves the external IP undimmed', async () => {
  install({ prefs: { passThrough: true, passThroughOpacity: 0.4 } }); await mount()
  expect(frame().getAttribute('data-pass-through')).toBe('true')
  expect(corners()).toHaveLength(4)
  for (const c of corners()) expect(c.style.borderStyle).toBe('dashed')
  // Opacity on any element between a node and the frame dims that node.
  const dimmedBelowFrame = (el: HTMLElement): boolean => {
    for (let n: HTMLElement | null = el; n && n !== frame(); n = n.parentElement) {
      if (n.style.opacity && Number(n.style.opacity) < 1) return true
    }
    return false
  }
  expect(dimmedBelowFrame(screen.getByTestId('hud-rec'))).toBe(true)
  expect(dimmedBelowFrame(screen.getAllByText('203.0.113.7')[0])).toBe(false)
})

it('draws solid corners when click-through is off', async () => {
  install(); await mount()
  expect(frame().getAttribute('data-pass-through')).toBeNull()
  for (const c of corners()) expect(c.style.borderStyle).toBe('solid')
})

// The overlay loads no app stylesheet, so the app-wide reduced-motion rule does
// not reach it; its own style block has to carry one.
it('stops its animations under prefers-reduced-motion', async () => {
  install({ safety: 'exposed' }); await mount()
  const css = Array.from(document.querySelectorAll('style')).map((st) => st.textContent).join('\n')
  const rule = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.hudMotion\s*\{\s*animation:\s*none !important;/
  expect(css).toMatch(rule)
  // and every animated element carries the class the rule names
  const animated = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => el.style.animation)
  expect(animated.length).toBeGreaterThan(0)
  for (const el of animated) expect(el.classList.contains('hudMotion')).toBe(true)
})

// Exposed with the flash pref on (the default): the panel itself pulses to a
// red tint with the frame and corner marks, not only a 1px border.
it('flashes the exposed panel background, with the frame and the corner marks', async () => {
  install({ safety: 'exposed' }); await mount()
  expect(frame().style.animation).toMatch(/\bhudAlarm\b(?!Mark)/)
  for (const c of corners()) expect(c.style.animation).toMatch(/\bhudAlarmMark\b/)
  const css = Array.from(document.querySelectorAll('style')).map((st) => st.textContent).join('\n')
  const keyframes = /@keyframes hudAlarm \{([\s\S]*?)\n\s*\}/.exec(css)?.[1] ?? ''
  expect(keyframes).toMatch(/background-color: #541d1e/)
  expect(keyframes).toMatch(/border-color: #ff4d4f/)
})

it('does not flash when the flash pref is off', async () => {
  install({ safety: 'exposed', prefs: { flashOnExposed: false } }); await mount()
  expect(frame().style.animation).toBe('')
  for (const c of corners()) expect(c.style.animation).toBe('')
})
