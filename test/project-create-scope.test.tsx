// @vitest-environment jsdom
//
// #588: creating a project used to ask for a name only, so the first scope an
// operator wrote meant leaving the flow for Settings. The card now takes the
// in-scope targets (and, folded away, the exclusions), through the same
// validator Settings uses, and sends them as the project's initial config.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'
import { resolveProfile } from '../src/core/profile-import'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

function mount() {
  const create = vi.fn(async (name: string) => ({ id: 'new', name, createdAt: 1, lastOpened: 2, path: '/tmp/new', dbSize: 0 }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => [], create, open: vi.fn(), delete: async () => true, rename: async () => ({ ok: true }), scopeSummaries: async () => ({}) },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
  return { create }
}

async function openCard(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Create new project' }))
  fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: name } })
  // Stitch 01: scope sits under "Advanced settings".
  fireEvent.click(screen.getByTestId('create-project-advanced'))
}

function addTo(label: string, text: string) {
  const field = screen.getByLabelText(label)
  fireEvent.change(field, { target: { value: text } })
  fireEvent.click(field.parentElement!.querySelector('button[aria-label="Add"]') as HTMLElement)
}

describe('create project with a scope', () => {
  it('sends the targets it was given as the initial scope', async () => {
    const { create } = mount()
    await openCard('Acme')
    addTo('Authorised targets (IP, CIDR, *.domain)', '10.0.0.0/24 *.acme.test')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][1]).toMatchObject({ scope: { targets: ['10.0.0.0/24', '*.acme.test'] } })
  })

  it('rejects an entry that could never match, instead of saving a dead rule', async () => {
    const { create } = mount()
    await openCard('Acme')
    addTo('Authorised targets (IP, CIDR, *.domain)', '10.0.0.0/33')
    expect(await screen.findByTestId('list-field-rejected')).toBeTruthy()
    // Stitch 01: the reject is still in the box, so creating stops and names it
    // rather than dropping it.
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByTestId('create-project-residual')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps exclusions in the folded advanced section', async () => {
    const { create } = mount()
    await openCard('Acme')
    addTo('Excluded targets (never in scope)', '10.0.0.5')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][1]).toMatchObject({ scope: { excludeTargets: ['10.0.0.5'] } })
  })

  it('sends nothing when the scope is left empty (it stays "not decided yet")', async () => {
    const { create } = mount()
    await openCard('Acme')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][1]).toBeUndefined()
  })

  it('adds what was typed to an imported profile instead of replacing it', async () => {
    const create = vi.fn(async (name: string) => ({ id: 'n', name, createdAt: 1, lastOpened: 2, path: '/tmp/n', dbSize: 0 }))
    ;(window as unknown as { redlog: unknown }).redlog = {
      project: { list: async () => [], create, open: vi.fn(), delete: async () => true, rename: async () => ({ ok: true }), scopeSummaries: async () => ({}) },
      config: { importProfile: async () => {
        const r = resolveProfile({ scope: { targets: ['10.1.0.0/16'] } })
        if (!r.ok) throw new Error('bad fixture')
        return { status: 'imported', profile: r.profile }
      }, get: async () => ({}), save: async () => true },
      ip: { getStatus: async () => ({ internalIP: null }) }
    }
    render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
    await openCard('Acme')
    fireEvent.click(screen.getByRole('button', { name: /Import Profile/ }))
    await screen.findByTestId('profile-applied')
    addTo('Authorised targets (IP, CIDR, *.domain)', '*.acme.test')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect((create.mock.calls[0] as unknown[])[1]).toMatchObject({ scope: { targets: ['10.1.0.0/16', '*.acme.test'] } })
  })
})
