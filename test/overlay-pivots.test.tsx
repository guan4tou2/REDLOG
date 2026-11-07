// @vitest-environment jsdom
//
// Spec 069 T019: the HUD lists relay nodes the same way the dashboard does —
// detected, not drawn as a route, and a failed read is not "none".

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'

type Pivot = { via: string; tool: string; route?: string; ts: number }
const unsub = (): void => {}
const NOW = Date.now()
const two: Pivot[] = [
  { via: '192.0.2.24:11601', tool: 'ligolo-ng', route: '172.16.10.0/24', ts: NOW - 35_000 },
  { via: '127.0.0.1:1080', tool: 'ssh -D', ts: NOW - 5_000 }
]

function install(getActive: () => Promise<Pivot[]>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay: {
      autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
      releaseFocus: vi.fn(), addMarker: vi.fn(), quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
    },
    config: { get: async () => ({ overlay: {} }) },
    ip: { getStatus: async () => ({ externalIP: '203.0.113.18', internalIP: '10.0.2.15', ipSafety: 'unknown', lastCheck: NOW }), onStatus: () => unsub },
    recording: { get: async () => null, onChange: () => unsub },
    pivots: { getActive, onChange: () => unsub }
  }
}
async function expanded(): Promise<void> {
  render(<I18nProvider><OverlayApp /></I18nProvider>)
  fireEvent.click(await screen.findByTestId('hud-expand'))
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('lists each node with tool, address, route and last seen — no arrows, no health claim', async () => {
  install(async () => two); await expanded()
  const block = await screen.findByTestId('hud-pivot-nodes')
  const text = block.textContent ?? ''
  expect(text).toContain('2 relay node(s) detected'.toUpperCase())
  expect(text).toContain('ligolo-ng')
  expect(text).toContain('192.0.2.24:11601')
  expect(text).toContain('subnet route: 172.16.10.0/24')
  expect(text).toContain('not checked')
  expect(text).not.toMatch(/[→▸]/)
})

it('says a failed read is a failed read, not "none"', async () => {
  install(async () => { throw new Error('x') }); await expanded()
  expect((await screen.findByTestId('hud-pivot-error')).textContent).toContain('Could not read relay nodes')
  expect(screen.queryByTestId('hud-pivot-nodes')).toBeNull()
})

it('shows nothing about relays when there are none', async () => {
  install(async () => []); await expanded()
  await screen.findAllByText('203.0.113.18')
  expect(screen.queryByTestId('hud-pivot-nodes')).toBeNull()
  expect(screen.queryByTestId('hud-pivot-error')).toBeNull()
})
