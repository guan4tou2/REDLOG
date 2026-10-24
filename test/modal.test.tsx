// @vitest-environment jsdom
// UI/UX audit F16: one modal contract — named dialog, focus moved in,
// Escape closes, and a decision dialog is not dismissed by a stray click.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../src/renderer/src/components/Modal'
import { IconButton } from '../src/renderer/src/components/IconButton'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Modal', () => {
  it('is a named modal dialog that takes focus and closes on Escape', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} label="Grant plugin"><button>Grant</button></Modal>)
    const dialog = screen.getByRole('dialog', { name: 'Grant plugin' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.textContent).toBe('Grant')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not steal focus after the operator has already interacted inside it', () => {
    let frame: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    render(<Modal open onClose={() => {}} label="Export"><button>Close</button><input aria-label="Attachment" /></Modal>)
    const input = screen.getByLabelText('Attachment'); input.focus()
    act(() => frame(0))
    expect(document.activeElement).toBe(input)
  })

  it('does not reset focus when an interacted field is temporarily replaced', () => {
    let frame: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const {rerender} = render(<Modal open onClose={() => {}} label="Export"><button>Close</button><input aria-label="Attachment" /></Modal>)
    screen.getByLabelText('Attachment').focus()
    rerender(<Modal open onClose={() => {}} label="Export"><button>Close</button></Modal>)
    act(() => frame(0))
    expect(document.activeElement).toBe(document.body)
  })

  it('ignores a backdrop click when the decision must be answered', () => {
    const onClose = vi.fn()
    const { container } = render(<Modal open alert dismissOnBackdrop={false} onClose={onClose} label="x"><p>body</p></Modal>)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(container.firstElementChild as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} label="x"><p>body</p></Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('IconButton', () => {
  it('always has an accessible name', () => {
    render(<IconButton label="Remove 10.0.0.1" onClick={() => {}}>×</IconButton>)
    expect(screen.getByRole('button', { name: 'Remove 10.0.0.1' })).toBeTruthy()
  })
})
