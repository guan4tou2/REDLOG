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
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => expect(open).toHaveBeenCalledWith('p1'))
  })

  // Stitch 01: a click selects, a double click opens.
  it('selects on click and opens on double click', async () => {
    const { open } = mount({ projects: [project('p1', 'Proj'), project('p2', 'Other')] })
    const second = await screen.findByRole('button', { name: 'Other' })
    fireEvent.click(second.closest('[role="option"]') as HTMLElement)
    expect(open).not.toHaveBeenCalled()
    expect(second.closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true')
    fireEvent.doubleClick(second)
    await waitFor(() => expect(open).toHaveBeenCalledWith('p2'))
  })

  it('moves the selection with the arrows and opens the selected row with Enter', async () => {
    const { open } = mount({ projects: [project('p1', 'Proj'), project('p2', 'Other')] })
    const first = await screen.findByRole('button', { name: 'Proj' })
    expect(first.closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const second = screen.getByRole('button', { name: 'Other' })
    expect(second.closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(second, { key: 'Enter' })
    await waitFor(() => expect(open).toHaveBeenCalledWith('p2'))
  })

  it('does not steal focus into "create" when there is something to open', async () => {
    mount({ projects: [project('p1', 'Proj')] })
    await screen.findByRole('button', { name: 'Proj' })
    expect(screen.queryByPlaceholderText('e.g. Client-Pentest-Q3')).toBeNull()
  })

  it('focuses the name field when creating and restores the trigger on cancel', async () => {
    mount({ projects: [] })
    const trigger = screen.getByRole('button', { name: 'Create new project' })
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
    fireEvent.doubleClick(row)
    fireEvent.doubleClick(row)
    expect(open).toHaveBeenCalledTimes(1)
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps duplicate names distinguishable by their paths', async () => {
    mount({ projects: [project('a', 'Same'), project('b', 'Same')] })
    await screen.findAllByRole('button', { name: 'Same' })
    expect(screen.getByText('/tmp/a')).toBeTruthy()
    expect(screen.getByText('/tmp/b')).toBeTruthy()
    // Stitch 01 / Spec 068 D1′: the search box is always there.
    expect(screen.queryByRole('searchbox')).not.toBeNull()
  })

})
