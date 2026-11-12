// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import HudPage from '../src/renderer/src/components/settings/HudPage'
import { DEFAULT_HUD_PREFS, type HudPrefs } from '../src/core/hud-prefs'

// Settings ▸ HUD reads and writes the machine-wide HUD prefs through their own
// IPC. It used to edit `config.overlay` and ride the project autosave, so each
// project had its own HUD.

function mount(initial: Partial<HudPrefs> = {}) {
  let listener: ((p: HudPrefs) => void) | null = null
  let current: HudPrefs = { ...DEFAULT_HUD_PREFS, ...initial }
  const bridge = {
    get: vi.fn(async () => current),
    set: vi.fn(async (partial: Partial<HudPrefs>) => { current = { ...current, ...partial }; return current }),
    onChanged: vi.fn((cb: (p: HudPrefs) => void) => { listener = cb; return () => { listener = null } })
  }
  ;(window as unknown as { redlog: unknown }).redlog = { hudPrefs: bridge }
  render(<HudPage t={(k) => k} />)
  return { bridge, push: (p: Partial<HudPrefs>) => act(() => listener?.({ ...current, ...p })) }
}

describe('Settings ▸ HUD', () => {
  afterEach(() => cleanup())

  it('shows the stored prefs and writes a change through hudPrefs, not the project config', async () => {
    const { bridge } = mount({ autoShow: false })
    const box = await screen.findByTestId('settings-overlay-autoshow') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(bridge.set).toHaveBeenCalledWith({ autoShow: true })
  })

  // Spec 060 FR-014 (carried over): the HUD opens by default.
  it('is on by default', async () => {
    expect(DEFAULT_HUD_PREFS.autoShow).toBe(true)
    mount()
    expect(((await screen.findByTestId('settings-overlay-autoshow')) as HTMLInputElement).checked).toBe(true)
  })

  it('moves one size per slider step', async () => {
    const { bridge } = mount({ scale: 1 })
    const slider = await screen.findByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('2')
    fireEvent.change(slider, { target: { value: '3' } })
    expect(bridge.set).toHaveBeenLastCalledWith({ scale: 1.25 })
  })

  it('offers every saved scale, one per slider step', async () => {
    const { bridge } = mount({ scale: 1 })
    const slider = await screen.findByRole('slider') as HTMLInputElement
    expect(slider.step).toBe('1')
    expect(slider.id).toBe('hud-scale')
    for (const [index, scale] of [0.75, 0.85, 1, 1.25, 1.5, 1.75].entries()) {
      if (index === 2) continue // already selected; a controlled input emits no change
      fireEvent.change(slider, { target: { value: String(index) } })
      expect(bridge.set).toHaveBeenLastCalledWith({ scale })
    }
  })

  // Carried over from hud-auto-show.test.tsx, which drove the old props.
  it('names the text-size slider, and reports the chosen step as its value', async () => {
    mount()
    const slider = await screen.findByRole('slider') as HTMLInputElement
    expect(slider.getAttribute('aria-label')).toBe('settings.overlayScale')
    expect(slider.getAttribute('aria-valuetext')).toBeTruthy()
    expect(document.querySelector('label[for="hud-scale"]')?.textContent).toBe('settings.overlayScale')
  })

  it('lets the named size buttons select a size', async () => {
    const { bridge } = mount({ scale: 1 })
    const normal = await screen.findByRole('button', { name: 'settings.overlayScale.normal' })
    expect(normal.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'settings.overlayScale.large' }))
    expect(bridge.set).toHaveBeenCalledWith({ scale: 1.25 })
  })

  it('mirrors a change made elsewhere — the HUD button, ⌘⇧P, the menu bar', async () => {
    const { push } = mount({ passThrough: false })
    await screen.findByTestId('settings-overlay-autoshow')
    expect(screen.queryByText('settings.overlayPassThroughOpacity')).toBeNull()
    push({ passThrough: true })
    expect(screen.getByText('settings.overlayPassThroughOpacity')).toBeTruthy()
  })

  // §8: while the external IP is exposed main refuses pass-through and answers
  // with the real state; the box that was just ticked unticks itself.
  it('shows what main stored, not what was ticked', async () => {
    const { bridge } = mount({ passThrough: false })
    bridge.set.mockImplementation(async () => ({ ...DEFAULT_HUD_PREFS, passThrough: false }))
    const box = (await screen.findByText('settings.overlayPassThrough')).closest('label')!.querySelector('input') as HTMLInputElement
    fireEvent.click(box)
    expect(bridge.set).toHaveBeenCalledWith({ passThrough: true })
    await vi.waitFor(() => expect(box.checked).toBe(false))
  })
})
