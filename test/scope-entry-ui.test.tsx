// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import GeneralPage from '../src/renderer/src/components/settings/GeneralPage'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('scope and project identity entry', () => {
  // The create card no longer asks for scope or exclusions: Settings > Scope
  // owns them, and asking twice is asking twice
  // (docs/UIUX-CONTROLS-AND-COPY.md §2). What it still carries at create time
  // comes from an imported profile, covered in
  // test/project-picker-create-card.test.tsx.

  it('renders an existing engagement ID as read-only', () => {
    // Its own bridge: this used to run on whatever the previous test left on
    // `window`, which is why removing that test broke this one.
    ;(window as unknown as { redlog: unknown }).redlog = {
      project: { active: async () => null, rename: vi.fn() }
    }
    const config = {
      engagement: { id: 'immutable-id' }, operator: { id: 'op', name: 'Operator' },
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
