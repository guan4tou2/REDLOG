// @vitest-environment jsdom
//
// The project picker carries the list and the one action, nothing that
// explains the screen (2026-11-12 reduction list, §F, project picker row):
// no wordmark and tagline above the panel, no keyboard hints, no page
// footer, and in the create dialog no subtitle and no note under the storage
// directory. The storage directory itself stays.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const META = { id: 'p1', name: 'Client-Q3', createdAt: 1, lastOpened: Date.now(), path: '/tmp/p1', dbSize: 2048 }

function mount(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: {
      list: async () => [META], create: vi.fn(), open: async () => null, delete: async () => true, rename: async () => ({ ok: true }),
      root: async () => '/home/op/.redlog/projects', scopeSummaries: async () => ({ p1: { state: 'unset' } })
    },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
}

describe('the project picker without its explanations', () => {
  it('starts with the panel: no wordmark, tagline, key hints or page footer', async () => {
    mount()
    await screen.findByText('Client-Q3')
    const picker = screen.getByTestId('project-picker')
    expect(picker.querySelector('[aria-label="REDLOG"]')).toBeNull()
    expect(picker.textContent).not.toContain('RED TEAM OPERATION LOG')
    expect(picker.querySelector('kbd')).toBeNull()
    expect(picker.querySelector('footer')).toBeNull()
    expect(picker.textContent).not.toMatch(/to browse|to open|local-first storage/)
    // The storage directory line is kept.
    await waitFor(() => expect(screen.getByTestId('project-picker-footer').textContent).toContain('/home/op/.redlog/projects'))
  })

  it('the create dialog has no subtitle and no note under the directory, and still names the directory', async () => {
    mount()
    await screen.findByText('Client-Q3')
    fireEvent.click(screen.getByTestId('project-new'))
    expect((await screen.findByTestId('create-project-root')).textContent).toBe('/home/op/.redlog/projects')
    const form = screen.getByTestId('create-project-form')
    expect(form.textContent).not.toMatch(/Initialise a local operation log|RedLog names it from the project name/)
  })

  it('ships none of the removed strings', () => {
    const gone = /^project\.(tagline|keyPress|keyBrowse|keyOpen|pageFooter|newSubtitle|storageFolderNote)$/
    for (const dict of [en, zh] as Array<Record<string, string>>) {
      expect(Object.keys(dict).filter((k) => gone.test(k))).toEqual([])
    }
  })
})
