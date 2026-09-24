// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'

// Spec 037: scope and exclusions are entered on the create card itself — the
// engagement's CIDRs are the one thing an operator should paste on entry.

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(opts: { internalIP?: string | null } = {}) {
  const create = vi.fn(async (name: string, _cfg?: unknown) => ({ id: 'p1', name, createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
  const stored = { engagement: { id: 'p1' }, scope: { targets: ['10.10.11.0/24'], excludeTargets: [], personalDomains: ['127.0.0.0/8', '::1', 'localhost'] } }
  const get = vi.fn(async () => stored)
  const save = vi.fn(async (_cfg: unknown) => true)
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => [], create, open: async () => null, delete: async () => true, rename: async () => ({ ok: true }) },
    config: { importProfile: async () => null, get, save },
    ip: { getStatus: async () => ({ internalIP: opts.internalIP ?? null }) }
  }
  const onOpen = vi.fn()
  render(<I18nProvider><ProjectPicker onProjectOpen={onOpen} /></I18nProvider>)
  fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: 'Lab' } })
  return { create, get, save, onOpen }
}

describe('ProjectPicker scope on the create card', () => {
  it('creates with the parsed scope and exclude arrays', async () => {
    const { create } = setup()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: '10.10.11.0/24, *.corp.local\n10.10.11.0/24' } })
    fireEvent.change(screen.getByLabelText('Excluded targets'), { target: { value: '10.10.11.1\n10.10.11.2' } })
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('Lab', expect.objectContaining({
      scope: expect.objectContaining({ targets: ['10.10.11.0/24', '*.corp.local'], excludeTargets: ['10.10.11.1', '10.10.11.2'] })
    })))
  })

  it('shows invalid entries inline and does not submit them', async () => {
    const { create } = setup()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: '10.10.11.0/24 10.0.0.0/33' } })
    expect(await screen.findByText(/will not be saved: 10\.0\.0\.0\/33/)).toBeTruthy()
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    const cfg = create.mock.calls[0][1] as { scope: { targets: string[] } }
    expect(cfg.scope.targets).toEqual(['10.10.11.0/24'])
  })

  it('adds this machine\'s IP to personalDomains, not excludeTargets, when ticked', async () => {
    const { create, save } = setup({ internalIP: '192.168.1.23' })
    const box = await screen.findByLabelText(/192\.168\.1\.23/)
    expect((box as HTMLInputElement).checked).toBe(false)
    fireEvent.click(box)
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    const createCfg = create.mock.calls[0][1] as { scope?: { excludeTargets?: string[] } } | undefined
    expect(createCfg?.scope?.excludeTargets ?? []).not.toContain('192.168.1.23')
    const saved = save.mock.calls[0][0] as { scope: { personalDomains: string[] } }
    // Appended — the default local-traffic patterns are kept.
    expect(saved.scope.personalDomains).toEqual(['127.0.0.0/8', '::1', 'localhost', '192.168.1.23'])
  })

  it('hides the local-traffic checkbox when no internal IP is known', async () => {
    setup({ internalIP: null })
    await Promise.resolve()
    expect(screen.queryByLabelText(/own traffic/)).toBeNull()
  })

  it('notes an empty scope without blocking creation', async () => {
    const { create, save, onOpen } = setup()
    expect(screen.getByText(/No scope set yet/)).toBeTruthy()
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: 'p1', name: 'Lab' }))
    expect(create).toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps scope and excludes out of the Advanced dialog', async () => {
    setup()
    fireEvent.click(screen.getByText('Advanced Setup (optional)'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('textarea')).toBeNull()
    expect(within(dialog).queryByLabelText('Scope')).toBeNull()
    expect(within(dialog).queryByLabelText('Excluded targets')).toBeNull()
  })
})
