// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({ confirmChainImpact: async () => true }))
afterEach(() => { cleanup(); window.localStorage.clear() })

const project = { id: 'p1', name: 'Alpha Recon', createdAt: 1, lastOpened: 2, path: '/tmp/p1', dbSize: 1024 }

function mount(del: () => Promise<boolean>): void {
  window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => [project], create: async () => project, open: async () => project, delete: del, rename: async () => ({ ok: true }) },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /><ToastContainer /></I18nProvider>)
}

describe('deleting a project from the picker', () => {
  it('keeps the row and says so when main throws', async () => {
    const del = vi.fn(async () => { throw new Error('EBUSY') })
    mount(del)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(del).toHaveBeenCalled())
    expect(await screen.findByText('Could not delete the project')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alpha Recon' })).toBeTruthy()
  })

  it('keeps the row and says so when main answers false', async () => {
    const del = vi.fn(async () => false)
    mount(del)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    expect(await screen.findByText('Could not delete the project')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alpha Recon' })).toBeTruthy()
  })

  it('removes the row when main answers true', async () => {
    mount(async () => true)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Alpha Recon' })).toBeNull())
  })
})
