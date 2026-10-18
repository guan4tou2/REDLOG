// @vitest-environment jsdom
//
// The HUD has one way to add a marker. The click that opens the form fixes the
// marker's time; the title is optional; Enter saves, Esc cancels; a failed save
// keeps what was typed and says so. The two rows below it are the HUD's own
// controls, named in words — and click-through says how to get back before it
// is pressed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import OverlayApp from '../src/renderer/src/OverlayApp'

const unsub = (): void => {}
let overlay: Record<string, ReturnType<typeof vi.fn>>

function install(addMarker: ReturnType<typeof vi.fn>): void {
  overlay = {
    autosize: vi.fn(), hide: vi.fn(), mouseEnter: vi.fn(), mouseLeave: vi.fn(), setPassThrough: vi.fn(),
    releaseFocus: vi.fn(), addMarker, quickMark: vi.fn(), onInteractive: vi.fn(() => unsub)
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    overlay,
    config: { get: async () => ({ overlay: { showMarkButton: true } }) },
    ip: { getStatus: async () => null, onStatus: () => unsub },
    recording: { get: async () => null, onChange: () => unsub }
  }
}

async function expanded(): Promise<void> {
  render(<I18nProvider><OverlayApp /></I18nProvider>)
  fireEvent.click(await screen.findByTestId('hud-expand'))
  await screen.findByTestId('hud-add-marker')
}

describe('HUD: add marker', () => {
  beforeEach(() => { vi.useRealTimers() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('has one marker button, with the other controls in words', async () => {
    install(vi.fn())
    await expanded()
    expect(screen.getAllByTestId('hud-add-marker')).toHaveLength(1)
    expect(screen.getByTestId('hud-add-marker').textContent).toMatch(/Add marker|新增標記/)
    expect(screen.getByTestId('hud-keep-open').textContent).toMatch(/Keep expanded|保持展開/)
    expect(screen.getByTestId('hud-pass-through').textContent).toMatch(/Click-through|滑鼠穿透/)
  })

  it('says how to get out of click-through before it is pressed', async () => {
    install(vi.fn())
    await expanded()
    expect(screen.getByTestId('hud-pass-through-hint').textContent).toMatch(/(⌘⇧P|Ctrl\+Shift\+P)/)
    expect(overlay.setPassThrough).not.toHaveBeenCalled()
  })

  it('saves with an empty title on Enter, timed at the click and not at save', async () => {
    const addMarker = vi.fn().mockResolvedValue({ ok: true, id: 'm1' })
    install(addMarker)
    await expanded()
    const before = Date.now()
    fireEvent.click(screen.getByTestId('hud-add-marker'))
    const after = Date.now()
    await new Promise((r) => setTimeout(r, 30))
    fireEvent.submit(screen.getByTestId('hud-marker-form'))
    await waitFor(() => expect(addMarker).toHaveBeenCalledTimes(1))
    const arg = addMarker.mock.calls[0][0] as { title: string; notes: string; at: number }
    expect(arg.title).toBe('')
    expect(arg.at).toBeGreaterThanOrEqual(before)
    expect(arg.at).toBeLessThanOrEqual(after)
    await waitFor(() => expect(overlay.releaseFocus).toHaveBeenCalled())
    expect(screen.queryByTestId('hud-marker-form')).toBeNull()
  })

  it('adds notes only after "More", and sends what was typed', async () => {
    const addMarker = vi.fn().mockResolvedValue({ ok: true })
    install(addMarker)
    await expanded()
    fireEvent.click(screen.getByTestId('hud-add-marker'))
    expect(screen.queryByTestId('hud-marker-notes')).toBeNull()
    fireEvent.click(screen.getByTestId('hud-marker-more'))
    fireEvent.change(screen.getByTestId('hud-marker-title'), { target: { value: 'login bypass' } })
    fireEvent.change(screen.getByTestId('hud-marker-notes'), { target: { value: 'via X-Forwarded-For' } })
    fireEvent.click(screen.getByTestId('hud-marker-save'))
    await waitFor(() => expect(addMarker).toHaveBeenCalledWith(expect.objectContaining({ title: 'login bypass', notes: 'via X-Forwarded-For' })))
  })

  it('Esc cancels, saves nothing and gives focus back', async () => {
    const addMarker = vi.fn()
    install(addMarker)
    await expanded()
    fireEvent.click(screen.getByTestId('hud-add-marker'))
    fireEvent.keyDown(screen.getByTestId('hud-marker-title'), { key: 'Escape' })
    expect(screen.queryByTestId('hud-marker-form')).toBeNull()
    expect(addMarker).not.toHaveBeenCalled()
    expect(overlay.releaseFocus).toHaveBeenCalled()
  })

  it('a failed save keeps the form and the typed title, and does not read as saved', async () => {
    const addMarker = vi.fn().mockResolvedValue({ ok: false })
    install(addMarker)
    await expanded()
    fireEvent.click(screen.getByTestId('hud-add-marker'))
    fireEvent.change(screen.getByTestId('hud-marker-title'), { target: { value: 'keep me' } })
    fireEvent.click(screen.getByTestId('hud-marker-save'))
    await screen.findByTestId('hud-marker-failed')
    expect((screen.getByTestId('hud-marker-title') as HTMLInputElement).value).toBe('keep me')
    expect(screen.queryByTestId('hud-add-marker')).toBeNull()
  })

  it('hands back the project the draft was started in, and says so when it changed', async () => {
    const addMarker = vi.fn().mockResolvedValue({ ok: false, reason: 'project-changed' })
    install(addMarker)
    overlay.beginMarker = vi.fn().mockResolvedValue('eng-a')
    await expanded()
    fireEvent.click(screen.getByTestId('hud-add-marker'))
    fireEvent.change(await screen.findByTestId('hud-marker-title'), { target: { value: 'half typed' } })
    fireEvent.submit(screen.getByTestId('hud-marker-form'))
    await waitFor(() => expect(addMarker).toHaveBeenCalled())
    expect(addMarker.mock.calls[0][0]).toMatchObject({ title: 'half typed', bind: 'eng-a' })
    const msg = await screen.findByTestId('hud-marker-failed')
    expect(msg.textContent).toMatch(/Project changed|專案已切換/)
    expect((screen.getByTestId('hud-marker-title') as HTMLInputElement).value).toBe('half typed')
  })
})
