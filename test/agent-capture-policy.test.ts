import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveAgentCapture } from '../src/core/agent-capture-policy'
const catalog = [{ agentKind: 'codex', pluginId: 'official-ai-codex', state: 'installed', installationId: 'install-1' }]
const plugins = [{ manifest: { id: 'official-ai-codex' }, status: 'active' }]
const config = { agentTailer: { sources: { codex: { enabled: true, installationId: 'install-1', workPaths: [path.resolve('work/client')], startedAt: 1000 } } } }
describe('official AI capture policy', () => {
  it('does not run default or legacy AI presets', () => {
    expect(resolveAgentCapture({}, catalog as never, plugins as never)).toEqual([])
    expect(resolveAgentCapture({ packs: { aiAgents: true } } as never, catalog as never, plugins as never)).toEqual([])
  })
  it('requires installation, enabled plugin, explicit project opt-in and a directory', () => {
    expect(resolveAgentCapture(config, catalog as never, plugins as never)).toEqual([{ agentKind: 'codex', workPaths: [path.resolve('work/client')], startedAt: 1000 }])
    expect(resolveAgentCapture(config, [], plugins as never)).toEqual([])
    expect(resolveAgentCapture(config, catalog as never, [])).toEqual([])
    expect(resolveAgentCapture({ agentTailer: { sources: { codex: { enabled: true, installationId: 'install-1', workPaths: [], startedAt: 1000 } } } }, catalog as never, plugins as never)).toEqual([])
    expect(resolveAgentCapture({ agentTailer: { sources: { codex: { enabled: false, workPaths: [path.resolve('work/client')], startedAt: 1000 } } } }, catalog as never, plugins as never)).toEqual([])
  })
  it('does not resume old project authorization after reinstalling', () => {
    expect(resolveAgentCapture(config, [{ ...catalog[0], installationId: 'new-receipt' }] as never, plugins as never)).toEqual([])
  })
  it('rejects missing activation boundaries and blank or relative working paths', () => {
    for (const value of [{ installationId: 'install-1', enabled: true, workPaths: ['/work'] }, { installationId: 'install-1', enabled: true, workPaths: [' '], startedAt: 1 }, { installationId: 'install-1', enabled: true, workPaths: ['relative'], startedAt: 1 }]) {
      expect(resolveAgentCapture({ agentTailer: { sources: { codex: value } } }, catalog as never, plugins as never)).toEqual([])
    }
  })
})
