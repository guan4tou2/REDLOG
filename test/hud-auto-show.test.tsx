// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import HudPage from '../src/renderer/src/components/settings/HudPage'
import { DEFAULT_CONFIG } from '../src/core/config'

// Spec 060 FR-014: the HUD opens by default and the operator can turn that off
// and have it stay off.
describe('HUD auto-show setting', () => {
  afterEach(() => cleanup())

  const draw = (overlay: Record<string, unknown>, setConfig = vi.fn()) => {
    ;(window as unknown as { redlog: unknown }).redlog = { overlay: { onPassThroughChanged: () => () => {}, setPassThrough: vi.fn() } }
    const config = { ...DEFAULT_CONFIG, overlay: { ...DEFAULT_CONFIG.overlay, ...overlay } }
    render(<HudPage config={config as never} setConfig={setConfig} t={(k) => k} />)
    return setConfig
  }

  it('is on by default and when the field is absent', () => {
    expect(DEFAULT_CONFIG.overlay.autoShow).toBe(true)
    draw({ autoShow: undefined })
    expect((screen.getByTestId('settings-overlay-autoshow') as HTMLInputElement).checked).toBe(true)
  })

  it('stores an off choice', () => {
    const setConfig = draw({})
    fireEvent.click(screen.getByTestId('settings-overlay-autoshow'))
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ overlay: expect.objectContaining({ autoShow: false }) }))
  })

  it('shows an off choice as off', () => {
    draw({ autoShow: false })
    expect((screen.getByTestId('settings-overlay-autoshow') as HTMLInputElement).checked).toBe(false)
  })

  // UIUX audit: the label above the slider was a `<label>` with no `for`, so
  // the range input had no accessible name at all — a screen reader announced
  // "slider" and nothing else. The value text beside it is not a name: it
  // changes as the slider moves.
  it('names the text-size slider, and reports the chosen step as its value', () => {
    draw({})
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.getAttribute('aria-label')).toBe('settings.overlayScale')
    expect(slider.getAttribute('aria-valuetext')).toBeTruthy()
    // The visible label is associated too, so a click on it focuses the slider.
    const label = document.querySelector('label[for="hud-scale"]')
    expect(label?.textContent).toBe('settings.overlayScale')
    expect(slider.id).toBe('hud-scale')
  })
})
