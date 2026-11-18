// @vitest-environment jsdom
//
// The expanded HUD says each thing once (owner, 2026-11-18: 「說明文字稍微多
// 思考如何簡化」). The external address is not repeated under the bar; the relay
// heading names where the nodes come from and no caveat sentence follows the
// list; a failed read still says it failed; the click-through explanation
// appears only while its control is hovered or focused.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'

type Pivot = { via: string; tool: string; route?: string; ts: number }
const unsub = (): void => {}
const NOW = Date.now()
const two: Pivot[] = [
  { via: '192.0.2.24:11601', tool: 'ligolo-ng', route: '172.16.10.0/24', ts: NOW - 35_000 },
  { via: '127.0.0.1:1080', tool: 'ssh -D', ts: NOW - 5_000 }
]

function install(getActive: () => Promise<Pivot[]> = async () => []): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay: {
      autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
      releaseFocus: vi.fn(), addMarker: vi.fn(), quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
    },
    config: { getPrefs: async () => ({ showMarkButton: true }) },
    ip: {
      getStatus: async () => ({ externalIP: '203.0.113.7', internalIP: '10.8.0.3', ipSafety: 'safe', lastCheck: NOW, error: null, link: { type: 'wifi', name: 'lab-net' } }),
      onStatus: () => unsub
    },
    recording: { get: async () => true, onChange: () => unsub },
    pivots: { getActive, onChange: () => unsub }
  }
}
async function expanded(): Promise<void> {
  render(<I18nProvider><OverlayApp /></I18nProvider>)
  fireEvent.click(await screen.findByTestId('hud-expand'))
  await act(async () => {})
}
const kvLabels = (): string[] => {
  const grid = screen.getByText('Last check').parentElement!
  return Array.from(grid.children).filter((_, i) => i % 2 === 0).map((c) => c.textContent ?? '')
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('does not repeat the external address under the bar, and the bar still shows the addresses and the network', async () => {
  install(); await expanded()
  expect(kvLabels()).not.toContain('External')
  expect(kvLabels()).toContain('Status')
  expect(kvLabels()).toContain('Last check')
  expect(screen.getAllByText('203.0.113.7')).toHaveLength(1)
  const bar = screen.getByTestId('hud-ip-state').closest('div')!
  for (const shown of ['203.0.113.7', '10.8.0.3', 'lab-net']) expect(bar.textContent).toContain(shown)
})

it('names the source in the relay heading and adds no caveat sentence under the list', async () => {
  install(async () => two); await expanded()
  const block = await screen.findByTestId('hud-pivot-nodes')
  const text = block.textContent ?? ''
  expect(text).toContain('Relay nodes 2 · detected from commands')
  expect(text).not.toMatch(/not verified|not checked|Seen in commands only/)
  expect(text).not.toMatch(/[→▸]/)
})

it('shows each node as tool, address, age and route, with "last seen" kept as the age\'s name', async () => {
  install(async () => two); await expanded()
  const block = await screen.findByTestId('hud-pivot-nodes')
  expect(block.textContent).not.toContain('last seen')
  expect(block.textContent).not.toContain('subnet route')
  expect(block.textContent).toContain('Route')
  expect(block.textContent).toContain('172.16.10.0/24')
  const ages = Array.from(block.querySelectorAll('[title]')).filter((el) => /^last seen /.test(el.getAttribute('title') ?? ''))
  expect(ages).toHaveLength(2)
  for (const age of ages) expect(age.getAttribute('aria-label')).toBe(age.getAttribute('title'))
})

it('still says a failed read failed — with no list, and with the last list kept', async () => {
  install(async () => { throw new Error('x') }); await expanded()
  expect((await screen.findByTestId('hud-pivot-error')).textContent).toContain('Could not read relay nodes')
  cleanup()

  install(async () => two)
  let notify!: (nodes: Pivot[]) => void
  window.redlog.pivots.onChange = (cb) => { notify = cb; return unsub }
  await expanded()
  await screen.findByTestId('hud-pivot-nodes')
  act(() => notify(null as unknown as Pivot[]))
  const err = await screen.findByTestId('hud-pivot-error')
  expect(err.textContent).toContain('Could not read; showing the last 2 read')
  // the warning sits under the relay heading, so "could not read" has its object
  expect(screen.getByTestId('hud-pivot-nodes').contains(err)).toBe(true)
})

it('shows the click-through explanation only while its control is hovered or focused', async () => {
  install(); await expanded()
  const button = screen.getByTestId('hud-pass-through')
  expect(screen.queryByTestId('hud-pass-through-hint')).toBeNull()
  expect(button.getAttribute('title')).toMatch(/⌘⇧P|Ctrl\+Shift\+P/)

  fireEvent.mouseEnter(button)
  const hint = screen.getByTestId('hud-pass-through-hint')
  expect(hint.textContent).toMatch(/⌘⇧P|Ctrl\+Shift\+P/)
  expect(button.getAttribute('aria-describedby')).toBe(hint.id)
  fireEvent.mouseLeave(button)
  expect(screen.queryByTestId('hud-pass-through-hint')).toBeNull()

  fireEvent.focus(button)
  expect(screen.getByTestId('hud-pass-through-hint')).toBeTruthy()
  fireEvent.blur(button)
  expect(screen.queryByTestId('hud-pass-through-hint')).toBeNull()
  expect(button.getAttribute('aria-describedby')).toBeNull()
})
