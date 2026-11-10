// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ConfirmOpts } from '../src/renderer/src/components/ConfirmDialog'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import en from '../src/renderer/src/i18n/en.json'

// Spec 066 batch B: the Plugins page is the single install / update / remove
// entry for official integrations, links both ways, and reads capture health.

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

vi.mock('../src/renderer/src/hooks/useContainerWidth', () => ({ useContainerWidth: () => [() => undefined, NaN] }))
const toasts: Array<{ message: string; opts: unknown }> = []
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.push({ message, opts }) },
  toastUndo: () => undefined
}))
const shown: ConfirmOpts[] = []
let answer = true
vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({
  confirmGraded: (opts: ConfirmOpts) => { shown.push(opts); return Promise.resolve(answer) }
}))

const entry = (state: string, over: Record<string, unknown> = {}) =>
  ({ agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex', source: {}, state, ...over })
const loadedView = (status = 'active') => ({
  id: 'official-ai-codex', name: 'Codex', version: '1.0.0', description: '', author: 'RedLog', source: 'bundled',
  tier: 'declarative', status, capabilities: [], contributes: [], report: null
})
const api = {
  list: vi.fn(), reload: vi.fn(), openFolder: vi.fn(), setEnabled: vi.fn(), grant: vi.fn(), revoke: vi.fn(),
  officialAgents: vi.fn(), installOfficialAgent: vi.fn(), uninstallOfficialAgent: vi.fn()
}
const health = vi.fn()
const snapshot = (sources: unknown[]) => ({ verdict: 'healthy', hasRecorded: false, sources, lastEventAt: null, checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null })
const config = (source?: Record<string, unknown>) =>
  ({ engagement: { id: 'p' }, agentTailer: { sources: source ? { codex: source } : {} } }) as never

function draw(props: Record<string, unknown> = {}): ReturnType<typeof render> {
  ;(window as unknown as { redlog: unknown }).redlog = { plugins: api, capture: { health } }
  return render(<PluginsPanel t={t} config={config()} {...props} />)
}
const open = async (): Promise<void> => { fireEvent.click(await screen.findByTestId('plugin-details-official-ai-codex')) }

describe('official integrations on the plugin page (Spec 066)', () => {
  beforeEach(() => {
    _resetCaptureHealth(); toasts.length = 0; shown.length = 0; answer = true
    Object.values(api).forEach((f) => f.mockReset()); health.mockReset()
    api.list.mockResolvedValue([]); api.officialAgents.mockResolvedValue([entry('not-installed')])
    api.installOfficialAgent.mockResolvedValue({ ok: true, changed: true, pluginId: 'official-ai-codex' })
    api.uninstallOfficialAgent.mockResolvedValue({ ok: true, changed: true, pluginId: 'official-ai-codex' })
    health.mockResolvedValue(snapshot([]))
  })
  afterEach(() => cleanup())

  it('installs, then draws what main now says rather than the button pressed', async () => {
    draw(); await open()
    expect(screen.getByTestId('plugin-install-state-official-ai-codex').textContent).toBe('Not installed')
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })])
    api.list.mockResolvedValue([loadedView()])
    fireEvent.click(screen.getByTestId('plugin-install-official-ai-codex'))
    await waitFor(() => expect(api.installOfficialAgent).toHaveBeenCalledWith('codex'))
    await waitFor(() => expect(screen.getByTestId('plugin-install-state-official-ai-codex').textContent).toBe('Installed'))
    expect(screen.queryByTestId('plugin-install-official-ai-codex')).toBeNull()
    expect(screen.getByTestId('plugin-uninstall-official-ai-codex')).toBeTruthy()
  })

  it('a refused install keeps the state it had and says why', async () => {
    api.installOfficialAgent.mockResolvedValue({ ok: false, error: 'disk full' })
    draw(); await open()
    fireEvent.click(screen.getByTestId('plugin-install-official-ai-codex'))
    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(JSON.stringify(toasts[0].opts)).toContain('disk full')
    expect(screen.getByTestId('plugin-install-state-official-ai-codex').textContent).toBe('Not installed')
  })

  it('an available update is the same button path, and the plugin stays removable', async () => {
    api.officialAgents.mockResolvedValue([entry('update-available', { installationId: 'i1' })])
    api.list.mockResolvedValue([loadedView()])
    draw(); await open()
    fireEvent.click(screen.getByTestId('plugin-update-official-ai-codex'))
    await waitFor(() => expect(api.installOfficialAgent).toHaveBeenCalledWith('codex'))
    expect(screen.getByTestId('plugin-uninstall-official-ai-codex')).toBeTruthy()
  })

  it('says what a removal stops and keeps before removing, and keeps it when declined', async () => {
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })])
    api.list.mockResolvedValue([loadedView()])
    answer = false
    draw(); await open()
    fireEvent.click(screen.getByTestId('plugin-uninstall-official-ai-codex'))
    await waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0].consequences).toEqual([en['settings.agents.removeStops'], en['settings.agents.removeKeeps']])
    expect(api.uninstallOfficialAgent).not.toHaveBeenCalled()
    answer = true
    fireEvent.click(screen.getByTestId('plugin-uninstall-official-ai-codex'))
    await waitFor(() => expect(api.uninstallOfficialAgent).toHaveBeenCalledWith('codex'))
  })

  it('restores a disabled integration through install — it has no enable switch, which main refuses', async () => {
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })])
    api.list.mockResolvedValue([loadedView('disabled')])
    draw(); await open()
    expect(screen.queryByTestId('plugin-detail-toggle-official-ai-codex')).toBeNull()
    api.list.mockResolvedValue([loadedView('active')])
    fireEvent.click(screen.getByTestId('plugin-restore-official-ai-codex'))
    await waitFor(() => expect(api.installOfficialAgent).toHaveBeenCalledWith('codex'))
    await waitFor(() => expect(screen.queryByTestId('plugin-restore-official-ai-codex')).toBeNull())
    expect(api.setEnabled).not.toHaveBeenCalled()
  })

  it('a conflict shows its message and offers no repair, only the folder', async () => {
    api.officialAgents.mockResolvedValue([entry('conflict', { error: 'Integration directory contains unrecognized or missing files' })])
    draw(); await open()
    expect(screen.getByTestId('plugin-install-error-official-ai-codex').textContent).toContain('unrecognized')
    expect(screen.queryByTestId('plugin-install-official-ai-codex')).toBeNull()
    expect(screen.queryByTestId('plugin-uninstall-official-ai-codex')).toBeNull()
    fireEvent.click(screen.getByTestId('plugin-open-folder-official-ai-codex'))
    expect(api.openFolder).toHaveBeenCalled()
    // and the detail names it as needing attention
    expect(screen.getByTestId('plugin-issues-official-ai-codex').textContent).toContain(en['plugins.issue.officialConflict'])
  })

  it('opens the integration the Capture sources link asked for — also when it is not installed — and writes nothing', async () => {
    const handled = vi.fn()
    draw({ focus: { pluginId: 'official-ai-codex' }, onFocusHandled: handled })
    await screen.findByTestId('plugin-detail-official-ai-codex')
    expect(handled).toHaveBeenCalled()
    expect(api.installOfficialAgent).not.toHaveBeenCalled(); expect(api.setEnabled).not.toHaveBeenCalled()
    expect(screen.getByTestId('plugin-install-state-official-ai-codex').textContent).toBe('Not installed')
  })

  it('jumps to the integration\'s Capture sources row with its agent kind', async () => {
    const jump = vi.fn()
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })]); api.list.mockResolvedValue([loadedView()])
    draw({ onOpenCaptureSources: jump }); await open()
    fireEvent.click(screen.getByTestId('plugin-open-capture-official-ai-codex'))
    expect(jump).toHaveBeenCalledWith('codex')
  })

  it('keeps the project axis and the health axis apart', async () => {
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })]); api.list.mockResolvedValue([loadedView()])
    health.mockResolvedValue(snapshot([{ id: 'agent-codex', enabled: false, lastEventAt: null, state: 'off' }]))
    draw({ config: config({ enabled: false }) }); await open()
    expect(screen.getByTestId('plugin-project-official-ai-codex').textContent).toBe(en['plugins.projectAxis.installedNotEnabled'])
    await waitFor(() => expect(screen.getByTestId('plugin-health-official-ai-codex').textContent).toBe(en['plugins.healthAxis.inactive']))
  })

  it('shows the last delivery, an error, and "unknown" when the read fails — never a stale verdict', async () => {
    api.officialAgents.mockResolvedValue([entry('installed', { installationId: 'i1' })]); api.list.mockResolvedValue([loadedView()])
    health.mockResolvedValue(snapshot([{ id: 'agent-codex', enabled: true, lastEventAt: Date.now(), state: 'ready' }]))
    draw({ config: config({ enabled: true, installationId: 'i1' }) }); await open()
    await waitFor(() => expect(screen.getByTestId('plugin-health-official-ai-codex').textContent).toContain('Last received'))
    expect(screen.getByTestId('plugin-project-official-ai-codex').textContent).toBe(en['plugins.projectAxis.recording'])
    cleanup(); _resetCaptureHealth()
    health.mockResolvedValue(snapshot([{ id: 'agent-codex', enabled: true, lastEventAt: Date.now(), state: 'error', lastError: { at: 1, message: 'ENOENT root' } }]))
    draw({ config: config({ enabled: true, installationId: 'i1' }) }); await open()
    await waitFor(() => expect(screen.getByTestId('plugin-health-official-ai-codex').textContent).toContain('ENOENT root'))
    cleanup(); _resetCaptureHealth()
    health.mockRejectedValue(new Error('down'))
    draw({ config: config({ enabled: true, installationId: 'i1' }) }); await open()
    await waitFor(() => expect(screen.getByTestId('plugin-health-official-ai-codex').textContent).toBe(en['plugins.healthAxis.unknown']))
  })
})

// Spec 067 US7: the catalog failing must not take the user's plugins with it.
describe('official catalog failure (Spec 067)', () => {
  beforeEach(() => {
    _resetCaptureHealth(); toasts.length = 0
    Object.values(api).forEach((f) => f.mockReset()); health.mockReset(); health.mockResolvedValue(snapshot([]))
  })
  afterEach(() => cleanup())
  const userPlugin = { ...loadedView(), id: 'mine', name: 'My plugin', source: 'user' }

  it('still lists the user plugins and says why the integrations are missing, with a retry', async () => {
    api.list.mockResolvedValue([userPlugin])
    api.officialAgents.mockRejectedValueOnce(new Error('ENOENT: optional-ai'))
    draw()
    await screen.findByText('My plugin')
    expect(screen.queryByTestId('plugins-load-error')).toBeNull()
    expect(screen.getByTestId('plugins-catalog-error').textContent).toContain('ENOENT: optional-ai')
    api.officialAgents.mockResolvedValue([entry('not-installed')])
    fireEvent.click(screen.getByTestId('plugins-catalog-retry'))
    await screen.findByTestId('plugin-details-official-ai-codex')
    expect(screen.queryByTestId('plugins-catalog-error')).toBeNull()
    expect(screen.getByText('My plugin')).toBeTruthy()
  })
  it('a failing plugin list is still the page-level load error', async () => {
    api.list.mockRejectedValue(new Error('list down')); api.officialAgents.mockResolvedValue([])
    draw()
    expect((await screen.findByTestId('plugins-load-error')).textContent).toContain('list down')
  })
})
