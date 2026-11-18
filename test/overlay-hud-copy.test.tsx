// @vitest-environment jsdom
//
// The expanded HUD says each thing once (owner, 2026-11-18: 「說明文字稍微多
// 思考如何簡化」, then 「兩列都拿掉，滑過看完整值」). The key/value block is status
// and last check; the bar's values carry their full text on hover; the relay
// heading names where the nodes come from and no caveat sentence follows the
// list; a failed read still says it failed; the click-through explanation
// appears only while its control is hovered or focused, never in click-through.

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

let passThroughCb: ((on: boolean, opacity: number) => void) | null = null
function install(getActive: () => Promise<Pivot[]> = async () => [], prefs: Record<string, unknown> = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay: {
      autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
      releaseFocus: vi.fn(), addMarker: vi.fn(), quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
    },
    config: {
      getPrefs: async () => ({ showMarkButton: true, ...prefs }),
      onPassThrough: (cb: (on: boolean, opacity: number) => void) => { passThroughCb = cb; return unsub }
    },
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
const kvLabels = (): string[] =>
  Array.from(screen.getByTestId('hud-kv').children).filter((_, i) => i % 2 === 0).map((c) => c.textContent ?? '')
/** Text an assistive tech reads: aria-hidden subtrees left out. */
const spoken = (el: Element): string => Array.from(el.childNodes).map((n) =>
  n.nodeType === Node.TEXT_NODE ? n.textContent ?? ''
    : (n as Element).getAttribute?.('aria-hidden') === 'true' ? '' : spoken(n as Element)).join('')
const hint = (): HTMLElement | null => screen.queryByTestId('hud-pass-through-hint')

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('keeps status and last check only; the bar shows the addresses and the network, each with its full value on hover', async () => {
  install(); await expanded()
  expect(kvLabels()).toEqual(['Status', 'Last check'])
  for (const value of ['203.0.113.7', '10.8.0.3', 'lab-net']) expect(screen.getAllByText(value)).toHaveLength(1)
  const bar = screen.getByTestId('hud-bar')
  for (const [id, value] of [['hud-ext-ip', '203.0.113.7'], ['hud-int-ip', '10.8.0.3'], ['hud-link', 'lab-net']]) {
    const el = screen.getByTestId(id)
    expect(bar.contains(el)).toBe(true)
    expect(el.textContent).toBe(value)
    expect(el.getAttribute('title')).toBe(value)
  }
})

it('names the source in the relay heading and adds no caveat sentence under the list', async () => {
  install(async () => two); await expanded()
  const block = await screen.findByTestId('hud-pivot-nodes')
  const text = block.textContent ?? ''
  expect(text).toContain('Relay nodes 2 · detected from commands')
  expect(text).not.toMatch(/not verified|not checked|Seen in commands only/)
  expect(text).not.toMatch(/[→▸]/)
})

it('shows each node as tool, address, age and route; "last seen" is read out and is the tooltip, not on screen', async () => {
  install(async () => two); await expanded()
  const block = await screen.findByTestId('hud-pivot-nodes')
  expect(block.textContent).not.toContain('subnet route')
  expect(block.textContent).toContain('Route')
  expect(block.textContent).toContain('172.16.10.0/24')
  const ages = Array.from(block.querySelectorAll('[title]')).filter((el) => /^last seen /.test(el.getAttribute('title') ?? ''))
  expect(ages).toHaveLength(2)
  for (const age of ages) {
    // what a screen reader gets is the whole phrase, once
    expect(spoken(age)).toBe(age.getAttribute('title'))
    // what the eye gets is the bare age
    const shown = age.querySelector('[aria-hidden="true"]')!
    expect(shown.textContent).not.toMatch(/last seen/)
    expect(age.getAttribute('title')).toContain(shown.textContent!)
  }
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

it('shows the click-through explanation only while its control is hovered or focused, and says it once', async () => {
  install(); await expanded()
  const button = screen.getByTestId('hud-pass-through')
  expect(hint()).toBeNull()
  // no tooltip: on hover it would repeat the line that appears
  expect(button.getAttribute('title')).toBeNull()
  // described for assistive tech while the line is not on screen
  const desc = document.getElementById(button.getAttribute('aria-describedby')!)!
  expect(desc.textContent).toMatch(/⌘⇧P|Ctrl\+Shift\+P/)

  fireEvent.mouseEnter(button)
  expect(hint()!.textContent).toBe(desc.textContent)
  expect(button.getAttribute('aria-describedby')).toBe(hint()!.id)
  expect(document.getElementById('hud-pt-desc')).toBeNull()
  fireEvent.mouseLeave(button)
  expect(hint()).toBeNull()

  fireEvent.focus(button)
  expect(hint()).not.toBeNull()
  fireEvent.blur(button)
  expect(hint()).toBeNull()
})

it('keeps the line while either hover or focus remains', async () => {
  install(); await expanded()
  const button = screen.getByTestId('hud-pass-through')
  fireEvent.focus(button); fireEvent.mouseEnter(button)
  fireEvent.mouseLeave(button)
  expect(hint()).not.toBeNull()
  fireEvent.mouseEnter(button); fireEvent.blur(button)
  expect(hint()).not.toBeNull()
  fireEvent.mouseLeave(button)
  expect(hint()).toBeNull()
})

it('does not bring the line back after the block collapsed with the button focused', async () => {
  install(); await expanded()
  fireEvent.focus(screen.getByTestId('hud-pass-through'))
  expect(hint()).not.toBeNull()
  // collapsing unmounts the button without a blur
  fireEvent.click(screen.getByTestId('hud-expand'))
  fireEvent.click(screen.getByTestId('hud-expand'))
  expect(screen.getByTestId('hud-pass-through')).toBeTruthy()
  expect(hint()).toBeNull()
})

it('shows no explanation while click-through is on, and drops it when click-through turns on', async () => {
  install(); await expanded()
  const button = screen.getByTestId('hud-pass-through')
  fireEvent.mouseEnter(button)
  expect(hint()).not.toBeNull()
  act(() => passThroughCb!(true, 0.4))
  expect(hint()).toBeNull()
  // main forwards mouse moves to a click-through window: a hover still arrives
  fireEvent.mouseLeave(button); fireEvent.mouseEnter(button); fireEvent.focus(button)
  expect(hint()).toBeNull()
})
