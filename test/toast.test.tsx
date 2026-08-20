// @vitest-environment jsdom
//
// The four §9 rules and the two §10 undo shapes. All of these are about what
// happens over time, which is exactly what a screenshot review cannot see:
// an error that quietly expired looks identical to one that was never raised.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ToastContainer, toast, toastUndo, toastDeferred, UNDO_MS } from '../src/renderer/src/components/Toast'

afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = (): void => {
  render(<I18nProvider><ToastContainer /></I18nProvider>)
}
const advance = async (ms: number): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

describe('toast lifetime', () => {
  it('expires a success but never an error', async () => {
    vi.useFakeTimers()
    mount()
    act(() => {
      toast('saved', 'success')
      toast('the chain broke', 'error')
    })
    expect(screen.getByText('saved')).toBeTruthy()

    await advance(10_000)
    expect(screen.queryByText('saved')).toBeNull()
    // Still there after ten seconds, and after a hundred.
    await advance(100_000)
    expect(screen.getByText('the chain broke')).toBeTruthy()
  })

  it('merges repeats into a count instead of stacking', async () => {
    vi.useFakeTimers()
    mount()
    act(() => { for (let i = 0; i < 40; i++) toast('poll failed', 'error') })
    expect(screen.getAllByText('poll failed')).toHaveLength(1)
    expect(screen.getByText('×40')).toBeTruthy()
  })

  it('shows at most three', async () => {
    vi.useFakeTimers()
    mount()
    act(() => { for (let i = 0; i < 6; i++) toast(`error ${i}`, 'error') })
    expect(screen.getAllByRole('alert')).toHaveLength(3)
    // The newest survive; the oldest are the ones dropped.
    expect(screen.queryByText('error 0')).toBeNull()
    expect(screen.getByText('error 5')).toBeTruthy()
  })

  it('announces errors assertively and everything else politely', () => {
    mount()
    act(() => {
      toast('quiet', 'success')
      toast('loud', 'error')
    })
    expect(screen.getByText('loud').closest('[role]')?.getAttribute('role')).toBe('alert')
    expect(screen.getByText('quiet').closest('[role]')?.getAttribute('role')).toBe('status')
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy()
  })

  it('puts the raw error behind a disclosure, not in the headline', () => {
    mount()
    act(() => {
      toast('Could not anchor', { type: 'error', why: 'Nothing timestamps the chain yet.', detail: 'ECONNREFUSED 1.2.3.4:443' })
    })
    expect(screen.getByText('Could not anchor')).toBeTruthy()
    expect(screen.getByText('Nothing timestamps the chain yet.')).toBeTruthy()
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull()

    fireEvent.click(screen.getByText(/details|詳細/i))
    expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy()
  })
})

describe('undo', () => {
  it('toastUndo runs the reversal when taken', () => {
    mount()
    const reverse = vi.fn()
    act(() => { toastUndo('Recording paused', reverse) })
    fireEvent.click(screen.getByText(/undo|復原/i))
    expect(reverse).toHaveBeenCalledOnce()
  })

  it('toastDeferred holds the side effect for the whole window', async () => {
    vi.useFakeTimers()
    mount()
    const commit = vi.fn()
    act(() => { toastDeferred('Disabled plugin', commit) })

    // The whole point: nothing has happened yet.
    await advance(UNDO_MS - 500)
    expect(commit).not.toHaveBeenCalled()

    await advance(1000)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('toastDeferred never commits if taken back, and reverts the optimistic view', async () => {
    vi.useFakeTimers()
    mount()
    const commit = vi.fn()
    const revert = vi.fn()
    act(() => { toastDeferred('Removed hook', commit, { revert }) })

    fireEvent.click(screen.getByText(/undo|復原/i))
    expect(revert).toHaveBeenCalledOnce()

    // §10's actual requirement: an undo inside the window leaves no trace,
    // so the write must not fire late either.
    await advance(UNDO_MS * 3)
    expect(commit).not.toHaveBeenCalled()
  })
})
