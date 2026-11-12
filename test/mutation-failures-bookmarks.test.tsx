// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { BookmarksView } from '../src/renderer/src/components/BookmarksView'
import { ToastContainer } from '../src/renderer/src/components/Toast'

vi.mock('../src/renderer/src/components/ConfirmDialog', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/ConfirmDialog')>()),
  confirm: async () => true
}))

// A bookmark write that fails must say so and keep what was typed; a pane must
// not close, or a row disappear, as if it had worked.

const mark = { id: 'm1', title: 'Existing', url: 'https://example.test/', note: '', createdAt: 1, context: {} }
let create: ReturnType<typeof vi.fn>
let del: ReturnType<typeof vi.fn>
let openExternal: ReturnType<typeof vi.fn>
let list: Bookmark[]

beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  list = []
  create = vi.fn(async () => null)
  del = vi.fn(async () => false)
  openExternal = vi.fn(async () => ({ ok: false, error: 'scheme not allowed' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    bookmarks: { list: async () => list, get: async () => list[0] ?? null, create: (...a: unknown[]) => create(...a), update: async () => null, delete: (...a: unknown[]) => del(...a) },
    cdp: { getTab: async () => ({ url: null, title: null, connected: false, port: 9222 }) },
    app: { openExternal: (...a: unknown[]) => openExternal(...a) }
  }
})
afterEach(() => { cleanup(); window.localStorage.clear() })

const mount = (): void => { render(<I18nProvider><ToastContainer /><BookmarksView /></I18nProvider>) }
const openForm = async (): Promise<HTMLInputElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Quick Capture' }))
  return (await screen.findByRole('textbox', { name: /Title/i })) as HTMLInputElement
}

describe('saving a bookmark', () => {
  it('keeps the form and what was typed, and says so, when the write is refused', async () => {
    mount()
    const title = await openForm()
    fireEvent.change(title, { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(await screen.findByText('The bookmark was not saved')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: /Title/i }) as HTMLInputElement).value).toBe('Keep me')
  })

  it('says so when the write rejects', async () => {
    create = vi.fn(async () => { throw new Error('db locked') })
    mount()
    fireEvent.change(await openForm(), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The bookmark was not saved')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Title/i })).toBeTruthy()
  })

  it('creates once on a double click and disables Save while in flight', async () => {
    let finish!: (v: unknown) => void
    create = vi.fn(() => new Promise((r) => { finish = r }))
    mount()
    fireEvent.change(await openForm(), { target: { value: 'Once' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.click(save); fireEvent.click(save)
    expect(create).toHaveBeenCalledTimes(1)
    expect(save.disabled).toBe(true)
    await act(async () => { finish(null) })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('deleting a bookmark', () => {
  it('stays on the bookmark and says so when it was not deleted', async () => {
    list = [mark]
    mount()
    fireEvent.click(await screen.findByText('Existing'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('m1'))
    expect(await screen.findByText('The bookmark was not deleted')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })
})

describe('opening a bookmark URL', () => {
  it('says so when main refuses the link', async () => {
    list = [{ ...mark, url: 'ftp://example.test/' }]
    mount()
    fireEvent.click(await screen.findByText('Existing'))
    fireEvent.click(await screen.findByTitle(/open/i))
    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    expect(await screen.findByText(/Could not open the link/)).toBeTruthy()
  })
})
