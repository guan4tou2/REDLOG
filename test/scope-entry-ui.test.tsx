// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import GeneralPage from '../src/renderer/src/components/settings/GeneralPage'
import ScopePage from '../src/renderer/src/components/settings/ScopePage'
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

  // Spec 037 FR: scope is pasted, split on newline/comma/space, and every entry
  // is validated against the scope evaluator. The requirement moved here with
  // the field -- the create card stopped asking -- and an entry the evaluator
  // can never match must not be stored as a rule that silently never fires.
  it('splits pasted scope, keeps what the evaluator can match, names what it cannot', () => {
    const setConfig = vi.fn()
    const config = {
      engagement: { id: 'p1' }, operator: { id: 'op', name: 'Operator' },
      network: { whitelist: [], blacklist: [], checkInterval: 60 },
      scope: { targets: [], excludeTargets: [], personalDomains: [], scopeFile: '' },
      screenshot: { quality: 80 }
    } as unknown as ConfigState
    render(
      <I18nProvider>
        <ScopePage config={config} setConfig={setConfig} t={(k: string) => k} />
      </I18nProvider>
    )

    const field = screen.getAllByPlaceholderText('settings.targetsPlaceholder')[0]
    // a real newline in the paste, which is what the requirement names
    fireEvent.change(field, { target: { value: `10.10.11.0/24, *.corp.local
10.0.0.0/33 host:8080` } })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })

    expect(setConfig).toHaveBeenCalledOnce()
    expect(setConfig.mock.calls[0][0].scope.targets).toEqual(['10.10.11.0/24', '*.corp.local'])

    // The rejects are named, and they stay in the box to be fixed in place.
    const alert = screen.getByTestId('list-field-rejected')
    expect(alert.textContent).toContain('10.0.0.0/33')
    expect(alert.textContent).toContain('host:8080')
    expect((field as HTMLInputElement).value).toBe('10.0.0.0/33 host:8080')
  })
})
