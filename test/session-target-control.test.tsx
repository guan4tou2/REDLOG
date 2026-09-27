// @vitest-environment jsdom
//
// #219: a built-in terminal can be bound to its own target, which outranks
// the global current target for that pane's events.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTargetControl } from '../src/renderer/src/components/SessionTargetControl'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => cleanup())

describe('SessionTargetControl', () => {
  it('says the pane follows the current target until bound, then binds and unbinds it', async () => {
    const bindings = new Map<string, string | null>()
    const bindSession = vi.fn(async (id: string, target: string | null) => { bindings.set(id, target); return { ok: true, target } })
    ;(window as unknown as { redlog: unknown }).redlog = {
      targetContext: { getSession: async (id: string) => bindings.get(id) ?? null, bindSession }
    }
    render(<I18nProvider><SessionTargetControl terminalId="term-1" /></I18nProvider>)
    const chip = await screen.findByTestId('session-target')
    expect(chip.textContent).toBe('follows current target')
    expect(chip.getAttribute('data-bound')).toBe('false')

    fireEvent.click(chip)
    fireEvent.change(screen.getByLabelText('This terminal’s target'), { target: { value: ' 10.10.11.5 ' } })
    fireEvent.submit(screen.getByTestId('session-target-form'))
    await waitFor(() => expect(bindSession).toHaveBeenCalledWith('term-1', '10.10.11.5'))
    expect((await screen.findByTestId('session-target')).textContent).toBe('target: 10.10.11.5')

    fireEvent.click(screen.getByTestId('session-target'))
    fireEvent.click(screen.getByText('Follow current target'))
    await waitFor(() => expect(bindSession).toHaveBeenLastCalledWith('term-1', null))
    expect((await screen.findByTestId('session-target')).getAttribute('data-bound')).toBe('false')
  })
})
