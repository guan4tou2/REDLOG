// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScopePage from '../src/renderer/src/components/settings/ScopePage'
import CaptureControlPage from '../src/renderer/src/components/settings/CaptureControlPage'
import NetworkPage from '../src/renderer/src/components/settings/NetworkPage'
import { ListField, type ConfigState } from '../src/renderer/src/components/settings/SettingsShared'
import { parseScopeInput } from '../src/renderer/src/lib/scopeInput'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const baseConfig = {
  engagement: { id: 'p1' }, operator: { id: 'op', name: 'Operator' },
  network: { whitelist: [], blacklist: [], checkInterval: 60 },
  scope: { targets: [], excludeTargets: [], personalDomains: [], scopeFile: '' },
  screenshot: { quality: 80 }
} as unknown as ConfigState

function describedBy(el: HTMLElement): HTMLElement[] {
  return (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)).filter((n): n is HTMLElement => n !== null)
}

describe('ListField accessible name', () => {
  it('gives every Scope list field a name its visible label provides', () => {
    render(
      <I18nProvider>
        <ScopePage config={baseConfig} setConfig={vi.fn()} t={(k: string) => k} />
      </I18nProvider>
    )
    const targets = screen.getByLabelText('settings.targetsLabel')
    const exclude = screen.getByLabelText('settings.excludeLabel')
    const personal = screen.getByLabelText('settings.personalDomainsLabel')
    expect(targets.tagName).toBe('TEXTAREA')
    expect(exclude.tagName).toBe('TEXTAREA')
    // the non-validating field is a single-line input
    expect(personal.tagName).toBe('INPUT')
    expect(new Set([targets, exclude, personal]).size).toBe(3)
  })

  it('names the list fields on the Network and Capture pages too', () => {
    // These pages probe the bridge on mount; an empty answer is enough.
    ;(window as unknown as { redlog: unknown }).redlog = {
      plugins: { list: async () => [] },
      hooks: { detect: async () => [] },
      capture: { health: async () => null }
    }
    const config = {
      ...baseConfig,
      network: { whitelist: [], blacklist: [], checkInterval: 60, providers: [] },
      fileWatcher: { watchPaths: [], ignorePatterns: [] },
      processMonitor: { pollMs: 1000, ignoreCommands: [] }
    } as unknown as ConfigState
    const { container: a } = render(
      <I18nProvider><CaptureControlPage config={config} setConfig={vi.fn()} t={(k: string) => k} /></I18nProvider>
    )
    const { container: b } = render(
      <I18nProvider><NetworkPage config={config} setConfig={vi.fn()} t={(k: string) => k} /></I18nProvider>
    )
    for (const root of [a, b]) {
      // Every list field is the input/textarea inside a `+` row; each must be
      // reachable by a non-empty accessible name.
      const unnamed = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]'))
        .filter((el) => el.closest('div.flex.gap-1.mb-1') && el.type !== 'checkbox')
        // The hand-rolled "custom VPN adapter" row is not a ListField and is
        // outside this change.
        .filter((el) => !el.getAttribute('placeholder')?.startsWith('settings.vpn'))
        .filter((el) => {
          const labelled = el.getAttribute('aria-labelledby')
          const byFor = el.id ? root.querySelector(`label[for="${el.id}"]`) : null
          return !labelled && !byFor
        })
      expect(unnamed).toEqual([])
    }
  })

  it('keeps two fields with the same label distinct', () => {
    render(
      <I18nProvider>
        <ListField label="Hosts" items={[]} onChange={vi.fn()} placeholder="a" />
        <ListField label="Hosts" items={[]} onChange={vi.fn()} placeholder="b" />
      </I18nProvider>
    )
    const [first, second] = screen.getAllByLabelText('Hosts')
    expect(first.id).not.toBe(second.id)
  })
})

describe('ListField validation wiring', () => {
  it('marks the field invalid and describes it by the rejection while rejects remain', () => {
    render(
      <I18nProvider>
        <ListField label="Targets" items={[]} onChange={vi.fn()} placeholder="p" parse={parseScopeInput} />
      </I18nProvider>
    )
    const field = screen.getByLabelText('Targets')
    expect(field.getAttribute('aria-invalid')).not.toBe('true')

    fireEvent.change(field, { target: { value: '10.0.0.0/33' } })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })

    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(field)).toContain(screen.getByTestId('list-field-rejected'))

    // editing the text clears the rejection, and the wiring with it
    fireEvent.change(field, { target: { value: '10.0.0.0/24' } })
    expect(field.getAttribute('aria-invalid')).not.toBe('true')
    expect(screen.queryByTestId('list-field-rejected')).toBeNull()
  })
})

describe('ListField draft state', () => {
  it('says a typed-but-not-added draft is not saved, and stops saying so once added', () => {
    const onChange = vi.fn()
    render(
      <I18nProvider>
        <ListField label="Domains" items={[]} onChange={onChange} placeholder="p" />
      </I18nProvider>
    )
    const field = screen.getByLabelText('Domains')
    expect(screen.queryByTestId('list-field-draft')).toBeNull()

    fireEvent.change(field, { target: { value: 'example.com' } })
    const note = screen.getByTestId('list-field-draft')
    expect(note.textContent).toMatch(/not saved/i)
    expect(note.textContent).toMatch(/Enter/)
    expect(describedBy(field)).toContain(note)

    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['example.com'])
    expect(screen.queryByTestId('list-field-draft')).toBeNull()
  })

  it('names Ctrl/Cmd+Enter on the multi-line field, and ignores whitespace-only drafts', () => {
    render(
      <I18nProvider>
        <ListField label="Targets" items={[]} onChange={vi.fn()} placeholder="p" parse={parseScopeInput} />
      </I18nProvider>
    )
    const field = screen.getByLabelText('Targets')
    fireEvent.change(field, { target: { value: '   ' } })
    expect(screen.queryByTestId('list-field-draft')).toBeNull()

    fireEvent.change(field, { target: { value: '10.0.0.0/24' } })
    expect(screen.getByTestId('list-field-draft').textContent).toMatch(/Ctrl/)
  })

  it('does not stack the draft note on top of the rejection message', () => {
    render(
      <I18nProvider>
        <ListField label="Targets" items={[]} onChange={vi.fn()} placeholder="p" parse={parseScopeInput} />
      </I18nProvider>
    )
    const field = screen.getByLabelText('Targets')
    fireEvent.change(field, { target: { value: 'host:8080' } })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(screen.getByTestId('list-field-rejected')).toBeTruthy()
    expect(screen.queryByTestId('list-field-draft')).toBeNull()
  })
})

describe('settings auto-save hint', () => {
  // Engagement ID is read-only (main forces it back to the stored value on
  // every save) and the operator ID applies live in the config handler, so
  // nothing here needs a project reopen.
  for (const lang of ['en', 'zh-TW']) {
    it(`${lang} does not claim an ID change needs reopening the project`, () => {
      const dict = JSON.parse(readFileSync(join(__dirname, '../src/renderer/src/i18n', `${lang}.json`), 'utf8')) as Record<string, string>
      expect(dict['settings.autoSaveHint']).toBeTruthy()
      expect(dict['settings.autoSaveHint']).not.toMatch(/reopen|重開|重新開啟/i)
    })
  }
})
