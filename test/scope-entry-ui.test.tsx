// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import GeneralPage from '../src/renderer/src/components/settings/GeneralPage'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('scope and project identity entry', () => {
  it('persists exclude targets entered during advanced project creation', async () => {
    const create = vi.fn(async () => ({ id: 'p1', name: 'Lab', createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
    ;(window as unknown as { redlog: unknown }).redlog = {
      project: { list: async () => [], create, open: async () => null, delete: async () => true, rename: async () => ({ ok: true }), active: async () => ({ id: 'p1' }) },
      config: { importProfile: async () => null }
    }
    render(<I18nProvider><ProjectPicker onProjectOpen={() => {}} /></I18nProvider>)
    fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: 'Lab' } })
    fireEvent.click(screen.getByText('Advanced Setup (optional)'))
    const dialog = await screen.findByRole('dialog')
    const exclude = within(dialog).getByPlaceholderText('127.0.0.1, Kali IP, or excluded CIDR')
    fireEvent.change(exclude, { target: { value: '127.0.0.1' } })
    fireEvent.keyDown(exclude, { key: 'Enter' })
    fireEvent.click(within(dialog).getByLabelText('Close'))
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('Lab', expect.objectContaining({
      scope: expect.objectContaining({ excludeTargets: ['127.0.0.1'] })
    })))
  })

  it('renders an existing engagement ID as read-only', () => {
    const config = {
      engagement: { id: 'immutable-id', name: 'Lab' }, operator: { id: 'op', name: 'Operator' },
      network: { whitelist: [], blacklist: [], checkInterval: 60 },
      scope: { targets: [], excludeTargets: [], scopeFile: '' }, screenshot: { quality: 80 }
    } as ConfigState
    render(<I18nProvider><GeneralPage config={config} setConfig={vi.fn()} /></I18nProvider>)
    const engagementId = screen.getAllByLabelText('ID')[0] as HTMLInputElement
    expect(engagementId.readOnly).toBe(true)
    expect(engagementId.value).toBe('immutable-id')
  })

  // One name: the project's. Settings used to edit a separate engagement.name
  // that only the Dashboard showed, while the title bar and the picker kept the
  // project name, so the two drifted apart.
  it('renames the project itself from Settings', async () => {
    const rename = vi.fn(async (_id: string, name: string) => ({ ok: true, name }))
    ;(window as unknown as { redlog: unknown }).redlog = {
      project: { active: async () => ({ id: 'p1', name: 'Old name', createdAt: 0 }), rename }
    }
    const renamed = vi.fn()
    window.addEventListener('redlog:project-renamed', renamed)
    const config = {
      engagement: { id: 'p1' }, operator: { id: 'op', name: 'Operator' },
      network: { whitelist: [], blacklist: [], checkInterval: 60 },
      scope: { targets: [], excludeTargets: [], scopeFile: '' }, screenshot: { quality: 80 }
    } as unknown as ConfigState
    render(<I18nProvider><GeneralPage config={config} setConfig={vi.fn()} /></I18nProvider>)
    const name = await screen.findByDisplayValue('Old name')
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.blur(name)
    await waitFor(() => expect(rename).toHaveBeenCalledWith('p1', 'New name'))
    expect(renamed).toHaveBeenCalledOnce()
    window.removeEventListener('redlog:project-renamed', renamed)
  })
})
