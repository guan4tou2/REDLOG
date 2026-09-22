// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ActiveTargetControl } from '../src/renderer/src/components/ActiveTargetControl'

describe('ActiveTargetControl', () => {
  const setTarget = vi.fn(async (target: string | null) => ({ ok: true, target }))

  beforeEach(() => {
    setTarget.mockClear()
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: {
        aggregateTargets: async () => [],
        onNewBatch: () => () => {}
      },
      config: { get: async () => ({ scope: { targets: [] } }) },
      targetContext: {
        get: async () => null,
        set: setTarget,
        onChange: () => () => {}
      }
    }
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('submits Enter once even though the input then blurs', async () => {
    render(<I18nProvider><ActiveTargetControl /></I18nProvider>)
    const input = await screen.findByTestId('active-target-input')
    fireEvent.change(input, { target: { value: '10.0.0.8' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(setTarget).toHaveBeenCalledTimes(1))
  })

  it('shows a visible failure and restores the saved value', async () => {
    setTarget.mockResolvedValueOnce({ ok: false, target: null })
    render(<I18nProvider><ActiveTargetControl /></I18nProvider>)
    const input = await screen.findByTestId('active-target-input')
    fireEvent.change(input, { target: { value: 'bad target' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Target could not be saved')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
  })
})
