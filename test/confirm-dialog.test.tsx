// @vitest-environment jsdom
//
// The three graded confirmations (UIUX-STANDARD §5.5) and the focus trap
// behind them (§4). Both are the kind of behaviour that no screenshot shows
// and that fails silently: a dialog that lets Tab escape looks identical to
// one that does not, and a gate that can be skipped by pressing Enter looks
// identical to one that cannot — right up until someone breaks a chain with a
// reflex keystroke.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import {
  ConfirmDialogContainer, confirm, confirmIrreversible, confirmChainImpact
} from '../src/renderer/src/components/ConfirmDialog'

afterEach(cleanup)

const mount = (): void => {
  render(
    <I18nProvider>
      <ConfirmDialogContainer />
    </I18nProvider>
  )
}

const pressEnter = (): void => { fireEvent.keyDown(window, { key: 'Enter' }) }
const pressEscape = (): void => { fireEvent.keyDown(window, { key: 'Escape' }) }

describe('graded confirmation', () => {
  it('plain: Enter confirms', async () => {
    mount()
    const answer = confirm('Clear filter', 'The events stay where they are.')
    await screen.findByRole('dialog')
    pressEnter()
    await expect(answer).resolves.toBe(true)
  })

  it('irreversible: the confirm button is disabled until the box is ticked', async () => {
    mount()
    const answer = confirmIrreversible({ title: 'Remove hook', message: 'This cannot be undone.' })
    await screen.findByRole('dialog')

    const button = screen.getByRole('button', { name: /delete|刪除/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)

    // Enter must not slip past the gate either — that is the whole point of
    // having one.
    pressEnter()
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await expect(answer).resolves.toBe(true)
  })

  it('chain: the exact project name has to be typed, and consequences are shown', async () => {
    mount()
    const answer = confirmChainImpact({
      title: 'Delete project',
      message: 'This breaks the evidence chain.',
      requireTyped: 'op-falcon',
      consequences: ['412 chained events go', 'The OTS anchor stops verifying']
    })
    await screen.findByRole('dialog')

    expect(screen.getByText('412 chained events go')).toBeTruthy()
    expect(screen.getByText('The OTS anchor stops verifying')).toBeTruthy()

    const button = screen.getByRole('button', { name: /delete|刪除/i })
    const field = screen.getByRole('textbox')
    expect((button as HTMLButtonElement).disabled).toBe(true)

    // A near miss is still a miss.
    fireEvent.change(field, { target: { value: 'op-falco' } })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))

    fireEvent.change(field, { target: { value: 'op-falcon' } })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await expect(answer).resolves.toBe(true)
  })

  it('Escape always resolves false, at every level', async () => {
    for (const open of [
      () => confirm('a', 'b'),
      () => confirmIrreversible({ title: 'a', message: 'b' }),
      () => confirmChainImpact({ title: 'a', message: 'b', requireTyped: 'x' })
    ]) {
      mount()
      const answer = open()
      await screen.findByRole('dialog')
      pressEscape()
      await expect(answer).resolves.toBe(false)
      cleanup()
    }
  })
})

describe('focus trap', () => {
  it('keeps Tab inside the dialog', async () => {
    mount()
    void confirm('Trapped', 'Tab should not leave.')
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const inside = [...dialog.querySelectorAll('button')]
    expect(inside.length).toBeGreaterThan(1)
    const first = inside[0]
    const last = inside[inside.length - 1]

    // Forward off the end wraps to the start.
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // Backward off the start wraps to the end.
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('pulls focus back when it is outside the dialog', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    mount()
    void confirm('Trapped', 'Focus belongs here.')
    const dialog = await screen.findByRole('dialog')

    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    outside.remove()
  })

  it('returns focus to whatever opened the dialog', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    mount()
    const answer = confirm('Give it back', 'On close.')
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    pressEscape()
    await answer
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })
})
