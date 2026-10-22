// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import AgentsPanel from '../src/renderer/src/components/settings/AgentsPanel'
const t = (key: string): string => key
let install: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>
let catalog: ReturnType<typeof vi.fn>
let pick: ReturnType<typeof vi.fn>
let saved: unknown
const uninstalled = { agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex', state: 'not-installed' }
const installed = { ...uninstalled, state: 'installed', installationId: 'receipt-1' }
function Harness({ onOpenPlugins }: { onOpenPlugins?: () => void } = {}) {
  const [config, setConfig] = useState({ engagement: { id: 'project-a' }, agentTailer: { sources: {} } })
  return <AgentsPanel t={t} config={config as never} setConfig={c => { saved = c; setConfig(c as never) }} onOpenPlugins={onOpenPlugins} />
}
beforeEach(() => {
  saved = undefined; catalog = vi.fn(async () => [uninstalled]); install = vi.fn(async () => ({ ok: true, changed: true })); remove = vi.fn(async () => ({ ok: true, changed: true })); pick = vi.fn(async () => '/work/client')
    ; (window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: catalog, installOfficialAgent: install, uninstallOfficialAgent: remove, list: async () => [{ id: 'official-ai-codex', status: 'active' }] }, agents: { sources: async () => [{ id: 'codex', label: 'Codex', root: '/h/.codex/sessions', detected: true }] }, hookConfig: { pickPath: pick } }
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
  it('offers a direct route to plugin settings without enabling or installing anything', async () => {
    catalog.mockResolvedValue([installed])
    window.redlog.plugins.list = vi.fn().mockResolvedValue([{ id: 'official-ai-codex', status: 'disabled' }])
    const onOpenPlugins = vi.fn()
    render(<Harness onOpenPlugins={onOpenPlugins} />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.agents.openPlugins' }))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
    expect(saved).toBeUndefined()
    expect(install).not.toHaveBeenCalled()
    expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).disabled).toBe(true)
  })
  it('makes a directory change visibly stop recording until the existing checkbox is explicitly enabled again', async () => {
    catalog.mockResolvedValue([installed])
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('agent-add-path-codex'))
    await screen.findByText('settings.agents.notRecording')
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(screen.queryByText('settings.agents.notRecording')).toBeNull()
    pick.mockResolvedValueOnce('/work/second-client')
    fireEvent.click(screen.getByTestId('agent-add-path-codex'))
    await screen.findByText('settings.agents.notRecording')
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: false, workPaths: ['/work/client', '/work/second-client'] } } } })
    expect((screen.getByTestId('agent-enabled-codex') as HTMLInputElement).checked).toBe(false)
    expect(screen.getAllByRole('checkbox').filter(input => input.getAttribute('data-testid') === 'agent-enabled-codex')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('agent-enabled-codex'))
    expect(saved).toMatchObject({ agentTailer: { sources: { codex: { enabled: true, installationId: 'receipt-1', startedAt: expect.any(Number) } } } })
    expect(screen.queryByText('settings.agents.notRecording')).toBeNull()
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
})
