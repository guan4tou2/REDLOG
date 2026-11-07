// @vitest-environment jsdom
//
// HUD states that must not claim more than is known: recording before it has
// been read, a safe IP read as protection, the newest relay by time, the
// expanded details while the IP is exposed, and the auto-collapse while a
// marker is being written.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'

type Pivot = { via: string; tool: string; route?: string; ts: number }
const unsub = (): void => {}
const NOW = Date.now()

function install(o: { recording?: () => Promise<boolean | null>; safety?: 'safe' | 'exposed' | 'unknown'; pivots?: Pivot[] } = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay: {
      autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
      releaseFocus: vi.fn(), addMarker: vi.fn(), quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
    },
    config: { get: async () => ({ overlay: { showMarkButton: true } }) },
    ip: { getStatus: async () => ({ externalIP: '203.0.113.18', internalIP: '10.0.2.15', ipSafety: o.safety ?? 'unknown', lastCheck: NOW }), onStatus: () => unsub },
    recording: { get: o.recording ?? (async () => true), onChange: () => unsub },
    pivots: { getActive: async () => o.pivots ?? [], onChange: () => unsub }
  }
}
const mount = (): void => { render(<I18nProvider><OverlayApp /></I18nProvider>) }

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); vi.useRealTimers(); window.localStorage.clear() })

it('does not say it is recording before it has been told', async () => {
  install({ recording: () => new Promise(() => {}) }); mount()
  expect((await screen.findByTestId('hud-rec')).textContent).toBe('REC?')
})

it('says unknown, not paused and not recording, when the read fails', async () => {
  install({ recording: async () => { throw new Error('x') } }); mount()
  expect((await screen.findByTestId('hud-rec')).textContent).toBe('REC?')
})

it('says recording once the main process has said so', async () => {
  install({ recording: async () => true }); mount()
  await act(async () => {})
  expect(screen.getByTestId('hud-rec').textContent).toBe('REC')
})

it('does not call a safe IP "protected"', async () => {
  install({ safety: 'safe' }); mount()
  fireEvent.click(await screen.findByTestId('hud-expand'))
  const text = document.body.textContent ?? ''
  expect(text).toContain('Matches your safe-IP list')
  expect(text).not.toMatch(/protected/i)
})

it('names the newest relay by time even when the list is not ordered', async () => {
  install({ pivots: [
    { via: 'old.example:1', tool: 'chisel', ts: NOW - 600_000 },
    { via: 'new.example:2', tool: 'ligolo-ng', ts: NOW - 1_000 },
    { via: 'mid.example:3', tool: 'ssh -D', ts: NOW - 60_000 }
  ] }); mount()
  const latest = await screen.findByTestId('hud-pivot-latest')
  expect(latest.textContent).toContain('new.example:2')
  expect(latest.textContent).toContain('+2')
})

it('keeps the details open while the IP is exposed, and says why', async () => {
  install({ safety: 'exposed' }); mount()
  const button = await screen.findByTestId('hud-expand')
  await act(async () => {})
  expect(button.getAttribute('title')).toBe('Details stay open while the external IP is exposed')
  fireEvent.click(button)
  expect(screen.queryByTestId('hud-add-marker')).not.toBeNull()
})

it('does not auto-collapse while a marker is being written', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  install(); mount()
  fireEvent.click(await screen.findByTestId('hud-expand'))
  fireEvent.click(await screen.findByTestId('hud-add-marker'))
  expect(screen.queryByRole('textbox')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(20_000) })
  expect(screen.queryByRole('textbox')).not.toBeNull()
})

it('still auto-collapses after 8 seconds when nothing is being written', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  install(); mount()
  fireEvent.click(await screen.findByTestId('hud-expand'))
  expect(screen.queryByTestId('hud-add-marker')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(9_000) })
  expect(screen.queryByTestId('hud-add-marker')).toBeNull()
})
