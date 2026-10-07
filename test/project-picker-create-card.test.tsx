// @vitest-environment jsdom
//
// The create card's advanced modal, audited out (docs/UIUX-CONTROLS-AND-COPY.md
// §5). It held four controls for three settings that Settings already owns —
// safe IPs and exposed IPs on the Network page, the violation warning on the
// Scope page — plus the modal's own open/close/done. Every one of them is a
// once-per-engagement decision at most, and two of them are once per machine.
//
// Importing a profile is the exception and stays: it is a create-time action,
// the same "once" as creating the project, and nowhere else in the app can do
// it. What it must not do is apply settings the card no longer shows without
// saying so.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PROFILE = {
  scope: { targets: ['10.10.11.0/24', '10.10.12.0/24'], warnOnViolation: false },
  network: { whitelist: ['10.0.0.1'], blacklist: ['8.8.8.8', '1.1.1.1'] }
}

function setup(profile: unknown = null) {
  const create = vi.fn(async (name: string, _cfg?: unknown) => ({ id: 'p1', name, createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => [], create, open: async () => null, delete: async () => true, rename: async () => ({ ok: true }) },
    config: { importProfile: async () => profile, get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
  fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: 'Lab' } })
  return { create }
}

describe('create card', () => {
  it('has no advanced modal', () => {
    setup()
    expect(screen.queryByText(/Advanced setup/i)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    // The three settings it held live on the Settings pages that own them.
    expect(screen.queryByText(/Safe IPs/i)).toBeNull()
    expect(screen.queryByText(/Exposed IPs/i)).toBeNull()
    expect(screen.queryByText(/Warn on scope violation/i)).toBeNull()
  })

  it('asks for a name, and nothing else', () => {
    setup()
    // Settings > Scope owns in-scope targets, exclusions, the violation
    // warning and personal domains. Asking for them again here is asking the
    // same question twice, on the screen an operator sees before every
    // engagement.
    expect(screen.getByPlaceholderText('e.g. Client-Pentest-Q3')).toBeTruthy()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByLabelText('Scope')).toBeNull()
    expect(screen.queryByLabelText('Excluded targets')).toBeNull()
  })

  it('imports a profile and says what it applied, with no modal to open', async () => {
    setup(PROFILE)
    fireEvent.click(screen.getByText(/Import Profile/i))
    // Nothing it carries is visible on the card, so all of it is named.
    const applied = await screen.findByTestId('profile-applied')
    expect(applied.textContent).toContain('Scope 2')
    expect(applied.textContent).toContain('Safe IPs 1')
    expect(applied.textContent).toContain('Exposed IPs 2')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still creates with everything the profile carried', async () => {
    const { create } = setup(PROFILE)
    fireEvent.click(screen.getByText(/Import Profile/i))
    await screen.findByTestId('profile-applied')
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('Lab', expect.objectContaining({
      scope: expect.objectContaining({ targets: ['10.10.11.0/24', '10.10.12.0/24'], warnOnViolation: false }),
      network: expect.objectContaining({ whitelist: ['10.0.0.1'], blacklist: ['8.8.8.8', '1.1.1.1'] })
    })))
  })
})
