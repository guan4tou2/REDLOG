// @vitest-environment jsdom
//
// The project list is the first thing an operator touches. It used to be a
// <div onClick> — a row that looks pressable but cannot be reached with Tab —
// and the only focused control on the screen was always "create a project",
// even for someone who came back to open one.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const project = (id: string, name: string) => ({ id, name, createdAt: 1, lastOpened: 2, path: `/tmp/${id}`, dbSize: 1024 })

function mount(opts: { projects?: ReturnType<typeof project>[]; rename?: () => Promise<unknown> } = {}) {
  const open = vi.fn(async () => project('p1', 'Proj'))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: {
      list: async () => opts.projects ?? [],
      create: async (name: string) => project('new', name),
      open,
      delete: async () => true,
      rename: opts.rename ?? (async () => ({ ok: true }))
    },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /><ToastContainer /></I18nProvider>)
  return { open }
}

describe('project list', () => {
  it('opens a project from a real button, so Tab and Enter work', async () => {
    const { open } = mount({ projects: [project('p1', 'Proj')] })
    const row = await screen.findByRole('button', { name: 'Proj' })
    fireEvent.click(row)
    await waitFor(() => expect(open).toHaveBeenCalledWith('p1'))
  })

  it('does not steal focus into "create" when there is something to open', async () => {
    mount({ projects: [project('p1', 'Proj')] })
    await screen.findByRole('button', { name: 'Proj' })
    expect(screen.queryByPlaceholderText('e.g. Client-Pentest-Q3')).toBeNull()
  })

  it('focuses the name field when creating and restores the trigger on cancel', async () => {
    mount({ projects: [] })
    const trigger = screen.getByRole('button', { name: 'New Project' })
    trigger.focus()
    fireEvent.click(trigger)
    const name = screen.getByPlaceholderText('e.g. Client-Pentest-Q3')
    await waitFor(() => expect(document.activeElement).toBe(name))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('says why a rename was refused instead of snapping back silently', async () => {
    mount({ projects: [project('p1', 'Proj')], rename: async () => ({ ok: false, error: 'locked by another window' }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    const field = screen.getByDisplayValue('Proj')
    fireEvent.change(field, { target: { value: 'Renamed' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText('Could not rename the project')).toBeTruthy()
  })
  it('ignores repeated opens until the current open finishes', async () => {
    const { open } = mount({ projects: [project('p1', 'Proj')] })
    open.mockImplementation(() => new Promise(() => {}))
    const row = await screen.findByRole('button', { name: 'Proj' })
    fireEvent.click(row)
    fireEvent.click(row)
    expect(open).toHaveBeenCalledTimes(1)
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it('searches names and paths, keeps duplicate names distinguishable, and reports no matches', async () => {
    mount({ projects: [project('a', 'Same'), project('b', 'Same')] })
    await screen.findAllByRole('button', { name: 'Same' })
    expect(screen.getByText('/tmp/a')).toBeTruthy()
    expect(screen.getByText('/tmp/b')).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.change(search, { target: { value: '/tmp/b' } })
    expect(screen.getAllByRole('button', { name: 'Same' })).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('No matching projects')
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByRole('button', { name: 'Same' })).toHaveLength(2)
  })

})
