import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveAgentCapture, agentTranscriptRoot } from '../src/core/agent-capture-policy'
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
  it('ignores a removed provider even when project authorization and its plugin remain', () => {
    const sources = { ...config.agentTailer.sources, opencode: { enabled: true, installationId: 'old-install', workPaths: [path.resolve('work/client')], startedAt: 1000 } }
    const installed = [...plugins, { manifest: { id: 'official-ai-opencode' }, status: 'active' }]
    expect(resolveAgentCapture({ agentTailer: { sources } }, catalog as never, installed as never)).toEqual([{ agentKind: 'codex', workPaths: [path.resolve('work/client')], startedAt: 1000 }])
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

describe('AI transcript source location', () => {
  const home = path.resolve('fixture-home')
  const claude = { source: { defaultPath: '.claude/projects', configEnv: 'CLAUDE_CONFIG_DIR', envSuffix: 'projects' } }
  const codex = { source: { defaultPath: '.codex/sessions', configEnv: 'CODEX_HOME', envSuffix: 'sessions' } }
  it('uses a project override before an absolute vendor environment root, then the default', () => {
    const vendor = path.resolve('vendor-home')
    const custom = path.resolve('來源 with spaces')
    expect(agentTranscriptRoot(claude, home, undefined, { CLAUDE_CONFIG_DIR: vendor })).toBe(path.join(vendor, 'projects'))
    expect(agentTranscriptRoot(codex, home, undefined, { CODEX_HOME: vendor })).toBe(path.join(vendor, 'sessions'))
    expect(agentTranscriptRoot(codex, home, { sourceRoot: custom }, { CODEX_HOME: vendor })).toBe(custom)
    expect(agentTranscriptRoot(claude, home, undefined, { CLAUDE_CONFIG_DIR: 'relative' })).toBe(path.join(home, '.claude', 'projects'))
    expect(agentTranscriptRoot(codex, home, undefined, {})).toBe(path.join(home, '.codex', 'sessions'))
  })
  it('refuses activation with a relative or blank explicit source', () => {
    for (const sourceRoot of ['relative', '']) {
      const source = { ...config.agentTailer.sources.codex, sourceRoot }
      expect(resolveAgentCapture({ agentTailer: { sources: { codex: source } } }, catalog as never, plugins as never)).toEqual([])
    }
  })
})
