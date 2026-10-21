import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { homedir } from 'node:os'

const m = vi.hoisted(() => ({
  list: vi.fn(), install: vi.fn(), uninstall: vi.fn(), factory: vi.fn(),
  reload: vi.fn(), plugins: vi.fn(() => []), health: vi.fn(), hooks: vi.fn(), insert: vi.fn(() => ({ id: 'audit' })), publish: vi.fn()
}))
vi.mock('electron', () => ({ shell: {} }))
vi.mock('../src/core/plugins/official-agents', () => ({ createOfficialAgentPluginManager: m.factory }))
vi.mock('../src/core/plugins', () => ({ listPlugins: m.plugins, listEventTypes: vi.fn(), setPluginEnabled: vi.fn(), grantPluginTrust: vi.fn(), revokePluginTrust: vi.fn(), reloadPlugins: m.reload }))
vi.mock('../src/core/config', () => ({ loadConfig: vi.fn() }))
vi.mock('../src/core/project-manager', () => ({ getProjectDir: vi.fn() }))
vi.mock('../src/core/plugins/test-sample', () => ({ testSample: vi.fn() }))
vi.mock('../src/core/plugins/contributions', () => ({ getContributionReport: vi.fn() }))
vi.mock('../src/core/capture-health', () => ({ invalidateHooksCache: m.health }))
vi.mock('../src/core/hooks-manager', () => ({ invalidateHooksCache: m.hooks }))
vi.mock('../src/core/db/events', () => ({ insertEvent: m.insert }))
vi.mock('../src/core/event-bus', () => ({ eventBus: { publish: m.publish } }))
import { registerPluginsIpc } from '../src/main/ipc/plugins'

type Handler = (_event: unknown, ...args: unknown[]) => unknown
function setup(engagement: string | null = 'eng') {
  const handlers = new Map<string, Handler>()
  const ctx = { getActiveProject: () => null, getCurrentEngagementId: () => engagement, getCurrentOperatorId: () => 'op', onPluginsChanged: vi.fn() }
  registerPluginsIpc({ handle: (name: string, fn: Handler) => handlers.set(name, fn) } as never, ctx as never)
  return { ctx, call: (name: string, ...args: unknown[]) => {
    expect(handlers.has(name)).toBe(true)
    return handlers.get(name)!({}, ...args)
  } }
}

describe('official AI installation IPC', () => {
  beforeEach(() => {
    Object.values(m).forEach(fn => fn.mockReset())
    m.factory.mockReturnValue({ list: m.list, install: m.install, uninstall: m.uninstall })
    m.list.mockReturnValue([{ agentKind: 'codex', pluginId: 'official-ai-codex', state: 'not-installed' }])
    m.insert.mockReturnValue({ id: 'audit' })
  })
  it('fixes the user plugin root in main and lists the catalog without mutation', () => {
    const { call, ctx } = setup()
    expect(m.factory).toHaveBeenCalledWith(path.join(homedir(), '.redlog', 'plugins'))
    expect(call('plugins:officialAgents')).toEqual(m.list())
    expect(m.install).not.toHaveBeenCalled()
    expect(ctx.onPluginsChanged).not.toHaveBeenCalled()
  })
  it('refreshes metadata and audits a successful install without writing project configuration', () => {
    m.install.mockReturnValue({ ok: true, changed: true, pluginId: 'official-ai-codex' })
    const { call, ctx } = setup()
    const extra = { destination: '/not-allowed' }
    expect(call('plugins:installOfficialAgent', 'codex', extra)).toMatchObject({ ok: true })
    expect(m.install).toHaveBeenCalledExactlyOnceWith('codex')
    expect(m.reload).toHaveBeenCalledTimes(1)
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
    expect(m.insert).toHaveBeenCalledWith('system', expect.objectContaining({ changed: { 'plugin.official-ai-codex.installed': { from: false, to: true } } }), { engagementId: 'eng', operatorId: 'op' })
  })
  it('does not turn a refused installation into a success or audit a change', () => {
    m.install.mockReturnValue({ ok: false, error: 'unknown integration' })
    const { call, ctx } = setup()
    expect(call('plugins:installOfficialAgent', '../escape')).toEqual({ ok: false, error: 'unknown integration' })
    expect(m.reload).not.toHaveBeenCalled()
    expect(m.insert).not.toHaveBeenCalled()
    expect(ctx.onPluginsChanged).not.toHaveBeenCalled()
  })
  it('does not reload for an unchanged install', () => {
    m.install.mockReturnValue({ ok: true, changed: false, pluginId: 'official-ai-codex' })
    const { call } = setup()
    call('plugins:installOfficialAgent', 'codex')
    expect(m.reload).not.toHaveBeenCalled()
    expect(m.insert).not.toHaveBeenCalled()
  })
  it('uninstalls without an engagement and still refreshes capture decisions', () => {
    m.uninstall.mockReturnValue({ ok: true, changed: true, pluginId: 'official-ai-codex' })
    const { call, ctx } = setup(null)
    call('plugins:uninstallOfficialAgent', 'codex')
    expect(m.uninstall).toHaveBeenCalledExactlyOnceWith('codex')
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
    expect(m.insert).not.toHaveBeenCalled()
  })
  it('refreshes after a partial removal but returns the cleanup error', () => {
    m.uninstall.mockReturnValue({ ok: false, error: 'directory busy', changed: true, pluginId: 'official-ai-codex' })
    const { call, ctx } = setup()
    expect(call('plugins:uninstallOfficialAgent', 'codex')).toMatchObject({ ok: false, error: 'directory busy' })
    expect(ctx.onPluginsChanged).toHaveBeenCalledTimes(1)
    expect(m.reload).toHaveBeenCalledTimes(1)
  })
})
