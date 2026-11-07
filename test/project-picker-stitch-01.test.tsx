// @vitest-environment jsdom
//
// Stitch 01: the create dialog folds scope under "Advanced settings", names
// where projects live, takes what is still typed in a scope box, and refuses an
// invalid leftover instead of dropping it.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

function mount(root: string | null = '/home/op/.redlog/projects') {
  const create = vi.fn(async (name: string, _cfg?: unknown) => ({ id: 'p1', name, createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: {
      list: async () => [], create, open: async () => null, delete: async () => true, rename: async () => ({ ok: true }),
      ...(root ? { root: async () => root } : {})
    },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))
  return { create }
}
const name = (v: string) => fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: v } })
const targets = () => screen.getByLabelText('Authorised targets (IP, CIDR, *.domain)') as HTMLTextAreaElement

describe('create dialog (Stitch 01)', () => {
  it('starts with the advanced settings folded and says no scope is set', async () => {
    mount()
    const toggle = screen.getByTestId('create-project-advanced')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('create-project-advanced-summary').textContent).toBe('Scope not set')
    expect(screen.queryByLabelText('Authorised targets (IP, CIDR, *.domain)')).toBeNull()
  })

  it('shows the directory projects are created in, not a guessed folder name', async () => {
    mount()
    expect((await screen.findByTestId('create-project-root')).textContent).toBe('/home/op/.redlog/projects')
    name('Lab')
    expect(screen.getByTestId('create-project-root').textContent).toBe('/home/op/.redlog/projects')
  })

  it('leaves the storage line out when the directory is not known', async () => {
    mount(null)
    await screen.findByTestId('create-project-advanced')
    expect(screen.queryByTestId('create-project-root')).toBeNull()
  })

  it('asks for a name instead of creating without one', async () => {
    const { create } = mount()
    fireEvent.click(screen.getByTestId('create-project-submit'))
    expect(await screen.findByTestId('create-project-name-missing')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
  })

  it('takes a valid entry still typed in the box, as if + had been pressed', async () => {
    const { create } = mount()
    name('Lab')
    fireEvent.click(screen.getByTestId('create-project-advanced'))
    fireEvent.change(targets(), { target: { value: '10.0.0.0/24' } })
    fireEvent.click(screen.getByTestId('create-project-submit'))
    await waitFor(() => expect(create).toHaveBeenCalledWith('Lab', expect.objectContaining({
      scope: expect.objectContaining({ targets: ['10.0.0.0/24'] })
    })))
  })

  it('refuses to create while an invalid entry is still typed, and names it', async () => {
    const { create } = mount()
    name('Lab')
    fireEvent.click(screen.getByTestId('create-project-advanced'))
    fireEvent.change(targets(), { target: { value: '10.0.0.0/24 10.0.0.0/33' } })
    fireEvent.click(screen.getByTestId('create-project-submit'))
    expect((await screen.findByTestId('create-project-residual')).textContent).toContain('10.0.0.0/33')
    expect(create).not.toHaveBeenCalled()
    // The valid half was taken; only the reject stays in the box.
    expect(targets().value).toBe('10.0.0.0/33')
    expect(screen.getByTestId('create-project-advanced-summary').textContent).toBe('1 authorised target(s) set')
  })

  it('keeps what was typed when the dialog is closed and opened again', async () => {
    mount()
    name('Startup Lab')
    fireEvent.click(screen.getByTestId('create-project-close'))
    await waitFor(() => expect(screen.queryByTestId('create-project-form')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))
    expect((screen.getByPlaceholderText('e.g. Client-Pentest-Q3') as HTMLInputElement).value).toBe('Startup Lab')
  })

  it('closes from the title bar', async () => {
    mount()
    fireEvent.click(screen.getByTestId('create-project-close'))
    await waitFor(() => expect(screen.queryByTestId('create-project-form')).toBeNull())
  })
})
