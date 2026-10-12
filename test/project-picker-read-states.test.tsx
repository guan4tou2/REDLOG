// @vitest-environment jsdom
//
// #298 (read states). A rejected project list used to be swallowed with
// `projects` starting at [], so loading, "no projects" and "could not read the
// list" were the same blank card. They are three different things, and the
// third must not read as lost evidence: the projects are on disk, only the
// listing failed.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const META = { id: 'p1', name: 'Client-Q3', createdAt: 1, lastOpened: 1, path: '/tmp/p1' }

function mount(list: () => Promise<unknown[]>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list, create: vi.fn(), open: async () => null, delete: async () => true, rename: async () => ({ ok: true }) },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
}

const status = (): HTMLElement => screen.getByTestId('project-list-status')

describe('project list read state', () => {
  it('while the list has not answered, it says it is reading, not that there are none', () => {
    mount(() => new Promise(() => {}))
    expect(status().getAttribute('data-state')).toBe('loading')
    expect(status().textContent).not.toMatch(/no projects/i)
  })

  it('an empty answer is its own state', async () => {
    mount(async () => [])
    await waitFor(() => expect(status().getAttribute('data-state')).toBe('empty'))
  })

  it('a rejected list is a failure that does not claim evidence is lost, and can be retried', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('EACCES: projects dir'))
      .mockResolvedValue([META])
    mount(list)

    await waitFor(() => expect(status().getAttribute('data-state')).toBe('failed'))
    expect(status().getAttribute('role')).toBe('alert')
    expect(status().textContent).toMatch(/on disk/i)
    expect(status().textContent).toContain('EACCES')
    expect(status().textContent).not.toMatch(/lost|missing|gone|deleted/i)
    expect(status().textContent).not.toMatch(/no projects/i)

    fireEvent.click(within(status()).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Client-Q3')).not.toBeNull()
    expect(screen.queryByTestId('project-list-status')).toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a loaded list shows no status at all', async () => {
    mount(async () => [META])
    expect(await screen.findByText('Client-Q3')).not.toBeNull()
    expect(screen.queryByTestId('project-list-status')).toBeNull()
  })
})
