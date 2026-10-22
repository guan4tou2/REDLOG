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

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'
import { resolveProfile, type ProfileImportResult } from '../src/core/profile-import'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PROFILE = {
  scope: { targets: ['10.10.11.0/24', '10.10.12.0/24'], warnOnViolation: false },
  network: { whitelist: ['10.0.0.1'], blacklist: ['8.8.8.8', '1.1.1.1'] }
}

// What the picker's native dialog would have produced, as the IPC now answers.
// Resolved with the production resolver, so a test cannot hand the card a
// profile the real IPC could not have.
function imp(data: unknown): ProfileImportResult {
  const r = resolveProfile(data)
  if (!r.ok) throw new Error(`bad fixture: ${JSON.stringify(r.failure)}`)
  return { status: 'imported', profile: r.profile }
}

/** Each click on Import takes the next answer; the last one repeats. */
function setup(...answers: ProfileImportResult[]) {
  let n = 0
  const next = async (): Promise<ProfileImportResult> => answers[Math.min(n++, answers.length - 1)] ?? { status: 'cancelled' }
  const create = vi.fn(async (name: string, _cfg?: unknown) => ({ id: 'p1', name, createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => [], create, open: async () => null, delete: async () => true, rename: async () => ({ ok: true }) },
    config: { importProfile: next, get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
  fireEvent.change(screen.getByPlaceholderText('e.g. Client-Pentest-Q3'), { target: { value: 'Lab' } })
  return { create }
}

describe('creating once', () => {
  it('ignores repeated Enter and clicks while the first create is pending', async () => {
    const { create } = setup()
    let finish!: (project: Awaited<ReturnType<typeof create>>) => void
    create.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const input = screen.getByPlaceholderText('e.g. Client-Pentest-Q3')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledTimes(1)
    await act(async () => finish({ id: 'p1', name: 'Lab', createdAt: 1, lastOpened: 1, path: '/tmp/p1' }))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('allows a new attempt after a rejected create, retaining the project name', async () => {
    const { create } = setup()
    create.mockRejectedValueOnce(new Error('create denied'))
    const input = screen.getByPlaceholderText('e.g. Client-Pentest-Q3') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false))
    expect(input.value).toBe('Lab')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  })
})

// #297. What the card shows after an import, and what project.create receives,
// are the same value; importing replaces rather than layers.
describe('importing a profile', () => {
  const A = { scope: { targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] } }
  const B = { scope: { targets: ['198.51.100.0/24'] } }

  async function importAgain(): Promise<void> {
    fireEvent.click(screen.getByText(/Import Profile/i))
    // The answer is a resolved promise; let the handler and its re-render land.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }

  async function createdWith(create: ReturnType<typeof setup>['create']): Promise<any> {
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    return create.mock.calls.at(-1)![1]
  }

  it('A then B: nothing of A survives, in the summary or in what is created', async () => {
    const { create } = setup(imp(A), imp(B))
    await importAgain()
    expect(screen.getByTestId('profile-applied').textContent).toContain('Excluded 1')
    await importAgain()
    await vi.waitFor(() => expect(screen.getByTestId('profile-applied').textContent).not.toContain('Excluded'))
    expect(screen.getByTestId('profile-applied').textContent).toBe('Scope 1')
    const cfg = await createdWith(create)
    expect(cfg.scope.targets).toEqual(['198.51.100.0/24'])
    expect(cfg.scope.excludeTargets).toEqual([])
  })

  it('B then A: the later profile is what is created', async () => {
    const { create } = setup(imp(B), imp(A))
    await importAgain()
    await importAgain()
    await vi.waitFor(() => expect(screen.getByTestId('profile-applied').textContent).toContain('Excluded 1'))
    const cfg = await createdWith(create)
    expect(cfg.scope).toMatchObject({ targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] })
  })

  it('the same profile twice does not pile up', async () => {
    const { create } = setup(imp(A))
    await importAgain()
    await importAgain()
    expect(screen.getByTestId('profile-applied').textContent).toBe('Scope 1 · Excluded 1')
    const cfg = await createdWith(create)
    expect(cfg.scope.targets).toEqual(['192.0.2.0/24'])
    expect(cfg.scope.excludeTargets).toEqual(['192.0.2.9'])
  })

  it('a profile that is only warnOnViolation:false is applied, and created', async () => {
    const { create } = setup(imp({ scope: { warnOnViolation: false } }))
    await importAgain()
    expect(screen.getByTestId('profile-applied').textContent).toContain('No warning on out-of-scope targets')
    const cfg = await createdWith(create)
    expect(cfg.scope.warnOnViolation).toBe(false)
  })

  it('a profile that is only exclusions is created', async () => {
    const { create } = setup(imp({ scope: { excludeTargets: ['192.0.2.9'] } }))
    await importAgain()
    const cfg = await createdWith(create)
    expect(cfg.scope.excludeTargets).toEqual(['192.0.2.9'])
    expect(cfg.scope.targets).toEqual([])
    expect(cfg.scope.warnOnViolation).toBe(true)
  })

  it('an explicit empty list replaces what the earlier profile put there', async () => {
    const { create } = setup(imp(A), imp({ scope: { excludeTargets: [] } }))
    await importAgain()
    await importAgain()
    const cfg = await createdWith(create)
    expect(cfg.scope.excludeTargets).toEqual([])
    expect(cfg.scope.targets).toEqual([])
  })

  it('a profile that restates the defaults is still an import, and is still passed', async () => {
    const { create } = setup(imp({ scope: { targets: [] } }))
    await importAgain()
    expect(screen.getByText('Clear imported settings')).toBeTruthy()
    const cfg = await createdWith(create)
    expect(cfg.scope.targets).toEqual([])
  })

  it('without an import there is no initialConfig', async () => {
    const { create } = setup()
    expect(await createdWith(create)).toBeUndefined()
  })

  it('clearing drops the summary, the button, and everything that would be created', async () => {
    const { create } = setup(imp(A))
    expect(screen.queryByText('Clear imported settings')).toBeNull()
    await importAgain()
    fireEvent.click(screen.getByText('Clear imported settings'))
    expect(screen.queryByTestId('profile-applied')).toBeNull()
    expect(screen.queryByText('Clear imported settings')).toBeNull()
    expect(await createdWith(create)).toBeUndefined()
  })

  it('cancelling the picker changes nothing and says nothing', async () => {
    const { create } = setup(imp(A), { status: 'cancelled' })
    await importAgain()
    fireEvent.click(screen.getByText(/Import Profile/i))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('profile-error')).toBeNull()
    expect(screen.getByTestId('profile-applied').textContent).toBe('Scope 1 · Excluded 1')
    const cfg = await createdWith(create)
    expect(cfg.scope.excludeTargets).toEqual(['192.0.2.9'])
  })

  it('a refused file leaves the earlier import exactly as it was, and says why', async () => {
    const { create } = setup(
      imp(A),
      { status: 'failed', failure: { code: 'shape', field: 'scope.targets', expected: 'list' } }
    )
    await importAgain()
    fireEvent.click(screen.getByText(/Import Profile/i))
    const err = await screen.findByTestId('profile-error')
    expect(err.textContent).toContain('scope.targets')
    expect(err.textContent).toContain('a list of text entries')
    expect(err.textContent).toMatch(/kept/i)
    expect(screen.getByTestId('profile-applied').textContent).toBe('Scope 1 · Excluded 1')
    const cfg = await createdWith(create)
    expect(cfg.scope).toMatchObject({ targets: ['192.0.2.0/24'], excludeTargets: ['192.0.2.9'] })
  })

  it('names read and parse failures differently, with the cause', async () => {
    setup({ status: 'failed', failure: { code: 'read', detail: 'EACCES: permission denied' } })
    fireEvent.click(screen.getByText(/Import Profile/i))
    expect((await screen.findByTestId('profile-error')).textContent).toMatch(/could not be read.*EACCES/)
    cleanup()
    setup({ status: 'failed', failure: { code: 'parse', detail: 'Unexpected end of JSON input' } })
    fireEvent.click(screen.getByText(/Import Profile/i))
    expect((await screen.findByTestId('profile-error')).textContent).toMatch(/not valid YAML or JSON.*Unexpected end/)
    // A refusal is not an import: there is nothing to clear.
    expect(screen.queryByText('Clear imported settings')).toBeNull()
    expect(screen.queryByTestId('profile-applied')).toBeNull()
  })

  it('the error goes away with the next good import', async () => {
    setup({ status: 'failed', failure: { code: 'empty' } }, imp(B))
    fireEvent.click(screen.getByText(/Import Profile/i))
    await screen.findByTestId('profile-error')
    await importAgain()
    expect(screen.queryByTestId('profile-error')).toBeNull()
  })
})

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
    setup(imp(PROFILE))
    fireEvent.click(screen.getByText(/Import Profile/i))
    // Nothing it carries is visible on the card, so all of it is named.
    const applied = await screen.findByTestId('profile-applied')
    expect(applied.textContent).toContain('Scope 2')
    expect(applied.textContent).toContain('Safe IPs 1')
    expect(applied.textContent).toContain('Exposed IPs 2')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still creates with everything the profile carried', async () => {
    const { create } = setup(imp(PROFILE))
    fireEvent.click(screen.getByText(/Import Profile/i))
    await screen.findByTestId('profile-applied')
    fireEvent.click(screen.getByText('Create'))
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('Lab', expect.objectContaining({
      scope: expect.objectContaining({ targets: ['10.10.11.0/24', '10.10.12.0/24'], warnOnViolation: false }),
      network: expect.objectContaining({ whitelist: ['10.0.0.1'], blacklist: ['8.8.8.8', '1.1.1.1'] })
    })))
  })
})
