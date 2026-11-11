// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventNoteField } from '../src/renderer/src/components/timeline/EventNoteField'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ToastContainer } from '../src/renderer/src/components/Toast'

const t = (k: string): string => k
let getNote: ReturnType<typeof vi.fn>
let setNote: ReturnType<typeof vi.fn>

beforeEach(() => {
  getNote = vi.fn(async () => null)
  setNote = vi.fn(async () => null)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getNote: (...a: unknown[]) => getNote(...a), setNote: (...a: unknown[]) => setNote(...a) }
  }
})
afterEach(() => cleanup())

const mount = (): void => { render(<I18nProvider><ToastContainer /><EventNoteField eventId="e1" t={t} /></I18nProvider>) }
const field = (): HTMLTextAreaElement => screen.getByTestId('event-note') as HTMLTextAreaElement

describe('reading an event note', () => {
  it('shows a failed read as a failure, not an empty editable field, and retries', async () => {
    getNote = vi.fn()
      .mockRejectedValueOnce(new Error('db busy'))
      .mockResolvedValueOnce({ note: 'existing note', createdAt: 1, updatedAt: 2 })
    mount()
    await screen.findByTestId('event-note-read-failed')
    expect(screen.queryByTestId('event-note')).toBeNull()
    fireEvent.click(screen.getByText('common.retry'))
    await waitFor(() => expect(field().value).toBe('existing note'))
    expect(screen.queryByTestId('event-note-read-failed')).toBeNull()
  })
})

describe('writing an event note', () => {
  it('keeps the text, says so, and retries on the next blur when the write is refused', async () => {
    setNote = vi.fn()
      .mockResolvedValueOnce(null)   // no active project
      .mockResolvedValueOnce({ note: 'typed', createdAt: 1, updatedAt: 2 })
    mount()
    await waitFor(() => expect(getNote).toHaveBeenCalled())
    fireEvent.change(field(), { target: { value: 'typed' } })
    fireEvent.blur(field())
    expect(await screen.findByText('timeline.detail.noteSaveFailed')).toBeTruthy()
    expect(field().value).toBe('typed')
    fireEvent.blur(field())
    await waitFor(() => expect(setNote).toHaveBeenCalledTimes(2))
  })

  it('retries after a rejection too', async () => {
    setNote = vi.fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce({ note: 'typed', createdAt: 1, updatedAt: 2 })
    mount()
    await waitFor(() => expect(getNote).toHaveBeenCalled())
    fireEvent.change(field(), { target: { value: 'typed' } })
    fireEvent.blur(field())
    expect(await screen.findByText('timeline.detail.noteSaveFailed')).toBeTruthy()
    fireEvent.blur(field())
    await waitFor(() => expect(setNote).toHaveBeenCalledTimes(2))
  })

  it('does not call a cleared note a failure (main answers null for it)', async () => {
    getNote = vi.fn(async () => ({ note: 'old', createdAt: 1, updatedAt: 2 }))
    mount()
    await waitFor(() => expect(field().value).toBe('old'))
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.blur(field())
    await waitFor(() => expect(setNote).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('timeline.detail.noteSaveFailed')).toBeNull()
    fireEvent.blur(field())
    expect(setNote).toHaveBeenCalledTimes(1)
  })
})
