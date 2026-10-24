// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ConfirmOpts } from '../src/renderer/src/components/ConfirmDialog'
import AgentsPanel from '../src/renderer/src/components/settings/AgentsPanel'

// #435: one source entry has to answer the whole question — installed here,
// recording for this project, what it reads, when it last delivered, and
// what to do when it is not. These tests pin the answers that used to live on
// three different screens, and the one action that resolves a changed scope.

const shown: ConfirmOpts[] = []
let answer = true

vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({
  confirmGraded: (opts: ConfirmOpts) => { shown.push(opts); return Promise.resolve(answer) }
}))

const t = (key: string): string => key
let install: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>
let catalog: ReturnType<typeof vi.fn>
let pick: ReturnType<typeof vi.fn>
let health: ReturnType<typeof vi.fn>
let saved: unknown
const uninstalled = { agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex', state: 'not-installed' }
const installed = { ...uninstalled, state: 'installed', installationId: 'receipt-1' }
function Harness() {
  const [config, setConfig] = useState({ engagement: { id: 'project-a' }, agentTailer: { sources: {} } })
  return <AgentsPanel t={t} config={config as never} setConfig={c => { saved = c; setConfig(c as never) }} />
}
const healthSnapshot = (sources: unknown[]): unknown => ({
  verdict: 'healthy', hasRecorded: false, sources, lastEventAt: null, checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null
})
beforeEach(() => {
  saved = undefined; shown.length = 0; answer = true
  catalog = vi.fn(async () => [uninstalled]); install = vi.fn(async () => ({ ok: true, changed: true })); remove = vi.fn(async () => ({ ok: true, changed: true })); pick = vi.fn(async () => '/work/client')
  health = vi.fn(async () => healthSnapshot([]))
  ; (window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: catalog, installOfficialAgent: install, uninstallOfficialAgent: remove, list: async () => [{ id: 'official-ai-codex', status: 'active' }] }, agents: { sessions: async () => [], sources: async () => [{ id: 'codex', label: 'Codex', root: '/h/.codex/sessions', detected: true }] }, hookConfig: { pickPath: pick }, capture: { health } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('AI optional installation settings', () => {
  it('shows an uninstalled integration without an activation checkbox', async () => {
    render(<Harness />); await screen.findByTestId('agent-install-codex')
    expect(screen.queryByTestId('agent-enabled-codex')).toBeNull(); expect(install).not.toHaveBeenCalled(); expect(saved).toBeUndefined()
  })
  it('installs only the chosen tool and does not activate capture', async () => {
    render(<Harness />); fireEvent.click(await screen.findByTestId('agent-install-codex'))
    await waitFor(() => expect(install).toHaveBeenCalledWith('codex')); expect(saved).toBeUndefined()
  })
  it('requires a project directory and explicitly binds activation to this installation', async () => {
    catalog.mockResolvedValue([installed]); render(<Harness />)
    const enable = await screen.findByTestId('agent-enabled-codex') as HTMLInputElement
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('agent-add-path-codex'))
    await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, workPaths: ['/work/client'], installationId: 'receipt-1', startedAt: expect.any(Number) } } } })
  })
  it('recovers a disabled integration here without authorizing the project', async () => {
    catalog.mockResolvedValue([installed])
    window.redlog.plugins.list = vi.fn().mockResolvedValue([{ id: 'official-ai-codex', status: 'disabled' }])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-restore-codex'))
    await waitFor(() => expect(install).toHaveBeenCalledWith('codex'))
    expect(saved).toBeUndefined()
    expect(screen.queryByTestId('agent-enabled-codex')).toBeNull()
  })
  it('stops recording and clears the activation boundary when the transcript source changes', async () => {
    catalog.mockResolvedValue([installed]); render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
    await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    pick.mockResolvedValueOnce('/custom/codex/sessions')
    fireEvent.click(screen.getByTestId('agent-source-path-codex'))
    await screen.findByTestId('agent-scope-changed-codex')
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { sourceRoot: '/custom/codex/sessions', enabled: false, startedAt: undefined, workPaths: ['/work/client'] } } } })
    expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).checked).toBe(false)
  })
  it('makes a directory change visibly stop recording until the existing checkbox is explicitly enabled again', async () => {
    catalog.mockResolvedValue([installed])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
    await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    pick.mockResolvedValueOnce('/work/second-client')
    fireEvent.click(screen.getByTestId('agent-add-path-codex'))
    // The source WAS recording, so the row names what happened — the scope
    // moved — instead of the generic "not recording" it shows for a source
    // that never started.
    await screen.findByText('settings.agents.scopeChanged')
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: false, workPaths: ['/work/client', '/work/second-client'] } } } })
    expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).checked).toBe(false)
    expect(screen.getAllByRole('checkbox').filter(input => input.getAttribute('data-testid') === 'agent-enabled-codex')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, installationId: 'receipt-1', startedAt: expect.any(Number) } } } })
    expect(screen.queryByText('settings.agents.scopeChanged')).toBeNull()
  })
  it('shows a source query error and offers retry instead of an empty list', async () => {
    catalog.mockRejectedValueOnce(new Error('permission denied')); render(<Harness />)
    expect((await screen.findByRole('alert')).textContent).toContain('permission denied')
    fireEvent.click(screen.getByText('common.retry')); await screen.findByTestId('agent-install-codex')
  })
  it('keeps installation failures visible', async () => {
    install.mockResolvedValue({ ok: false, error: 'disk full' }); render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-install-codex'))
    expect((await screen.findByRole('alert')).textContent).toContain('disk full'); expect(saved).toBeUndefined()
  })

  // #435: the scope moved under a source that was recording. The row has to
  // say THAT happened, not the generic "not recording" that reads the same
  // whether the source was never enabled or was just switched off — and the
  // one action that resolves it has to be on the same row.
  it('says the scope changed and turns the project checkbox into the confirming action', async () => {
    catalog.mockResolvedValue([installed])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
    await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true } } } })
    pick.mockResolvedValueOnce('/work/second-client')
    fireEvent.click(screen.getByTestId('agent-add-path-codex'))
    await screen.findByText('settings.agents.scopeChanged')
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: false, scopeChangedAt: expect.any(Number) } } } })
    // One control, not two ways to do the same thing: the checkbox is the
    // action, and its label says what ticking it does.
    expect(screen.getAllByRole('checkbox').filter(input => input.getAttribute('data-testid') === 'agent-enabled-codex')).toHaveLength(1)
    expect(screen.getByText('settings.agents.confirmScope')).toBeTruthy()
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, startedAt: expect.any(Number) } } } })
    expect((saved as { agentTailer: { sources: { codex: { scopeChangedAt?: number } } } }).agentTailer.sources.codex.scopeChangedAt).toBeUndefined()
  })

  it('does not claim the scope changed when nothing was recording yet', async () => {
    catalog.mockResolvedValue([installed])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
    await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
    expect(screen.queryByText('settings.agents.scopeChanged')).toBeNull()
    expect((saved as { agentTailer: { sources: { codex: { scopeChangedAt?: number } } } }).agentTailer.sources.codex.scopeChangedAt).toBeUndefined()
  })

  it('reports when the source last delivered, and that it never has', async () => {
    catalog.mockResolvedValue([installed])
    health.mockResolvedValue(healthSnapshot([{ id: 'agent-codex', installed: true, enabled: true, lastEventAt: Date.now(), state: 'ready' }]))
    render(<Harness />)
    expect((await screen.findByTestId('source-last-agent-codex')).textContent).toContain('settings.source.lastReceived')
    health.mockResolvedValue(healthSnapshot([{ id: 'agent-codex', installed: true, enabled: true, lastEventAt: null, state: 'unset' }]))
    cleanup(); render(<Harness />)
    expect((await screen.findByTestId('source-last-agent-codex')).textContent).toContain('settings.source.neverReceived')
  })

  it('says nothing about a source that is off and has never delivered', async () => {
    catalog.mockResolvedValue([installed])
    health.mockResolvedValue(healthSnapshot([{ id: 'agent-codex', installed: true, enabled: false, lastEventAt: null, state: 'off' }]))
    render(<Harness />)
    await screen.findByTestId('agent-source-codex')
    expect(screen.queryByTestId('source-last-agent-codex')).toBeNull()
  })

  it('names what a local removal stops and what it keeps before removing', async () => {
    catalog.mockResolvedValue([installed])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-remove-codex'))
    await waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0].title).toBe('settings.agents.removeTitle')
    expect(shown[0].consequences).toContain('settings.agents.removeStops')
    expect(shown[0].consequences).toContain('settings.agents.removeKeeps')
    await waitFor(() => expect(remove).toHaveBeenCalledWith('codex'))
  })

  it('keeps the integration when the removal is not confirmed', async () => {
    catalog.mockResolvedValue([installed])
    answer = false
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-remove-codex'))
    await waitFor(() => expect(shown).toHaveLength(1))
    expect(remove).not.toHaveBeenCalled()
  })

  // UIUX audit: with the integration not installed, the row still said "start
  // the AI tool, then reopen this project" when the transcript folder was
  // missing — advice that records nothing, with no way to tell why. The folder
  // is a fact about the AI tool; whether it can be read is a fact about the
  // integration, and only the installed row has anything to do with it.
  it('does not tell an uninstalled integration to start the AI tool', async () => {
    catalog.mockResolvedValue([uninstalled])
    window.redlog.agents.sources = async () => [
      { id: 'codex', label: 'Codex', root: '/h/.codex/sessions', detected: false }
    ]
    render(<Harness />)
    const card = await screen.findByTestId('agent-source-codex')
    expect(screen.queryByTestId('agent-details-codex')).toBeNull()
  })

  it('keeps a missing transcript directory visible in source settings', async () => {
    catalog.mockResolvedValue([installed])
    window.redlog.agents.sources = async () => [
      { id: 'codex', label: 'Codex', root: '/h/.codex/sessions', detected: false }
    ]
    render(<Harness />)
    const card = await screen.findByTestId('agent-source-codex')
    expect(card.textContent).toContain('settings.agents.notDetected')
  })
})


it('stops only the selected conversation and reauthorizes it from now', async () => {
  catalog.mockResolvedValue([installed])
  window.redlog.agents.sessions = vi.fn(async () => [{ agentKind: 'codex', sessionId: 'session-a', cwd: '/work/client', recording: true }])
  render(<Harness />)
  fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
  await waitFor(() => expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('agent-enabled-codex'))
  fireEvent.click(await screen.findByTestId('agent-session-session-a'))
  expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, excludedSessions: ['session-a'] } } } })
  fireEvent.click(await screen.findByTestId('agent-session-session-a'))
  expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, excludedSessions: [], sessionStarts: { 'session-a': expect.any(Number) } } } } })
})

it('offers an official package update here without granting project permission', async () => {
  catalog.mockResolvedValue([{ ...installed, state: 'update-available' }])
  render(<Harness />)
  fireEvent.click(await screen.findByTestId('agent-update-codex'))
  await waitFor(() => expect(install).toHaveBeenCalledWith('codex'))
  expect(saved).toBeUndefined()
  expect(screen.queryByTestId('agent-enabled-codex')).toBeNull()
})
