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
})
