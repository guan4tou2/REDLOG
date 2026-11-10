// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { applyContributions, removeContributions, getContributionReport, tailerUnsupportedReason } from '../src/core/plugins/contributions'
import { registerLootPatterns, unregisterLootPatterns } from '../src/core/loot-detector'
import type { LoadedPlugin } from '../src/core/plugins/types'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import en from '../src/renderer/src/i18n/en.json'

// #348: a manifest that loads is not every rule in it working. The result of
// applying a plugin's contributions is kept and shown.

const plugin = (id: string, contributes: Record<string, unknown>, over: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  manifest: { id, name: id, version: '1.0.0', redlogApi: 1, contributes } as LoadedPlugin['manifest'],
  dir: '/nowhere', source: 'user', tier: 'declarative', status: 'active', contentHash: 'x', ...over
})

describe('contribution report', () => {
  afterEach(() => { removeContributions('mix'); removeContributions('allbad'); removeContributions('ut'); cleanup() })

  // #348: the four kinds that could fail quietly now report like loot and
  // redaction do. A manifest that loads is not every rule in it working.
  it('reports accepted and rejected target extractors, command tags, event types and captures', () => {
    const r = applyContributions(plugin('allkinds', {
      targetExtractors: [
        { cmd: '^okscan\\s', extract: '--host\\s+(\\S+)', name: 'okscan-target' },
        { cmd: '[unterminated', extract: '.*', name: 'broken-cmd' },
        { cmd: '^nope\\s', strategy: 'not-a-strategy', name: 'bad-strategy' }
      ],
      commandTags: [
        { name: 'good-tag', match: '^nmap\\b', stamp: { phase: 'recon' } },
        { name: 'bad-tag', match: '([', stamp: { phase: 'x' } }
      ],
      eventTypes: [
        { agentType: 'good', label: 'Good' },
        { agentType: '', label: 'No type' }
      ],
      capture: [
        { id: 'good-cap', name: 'Good', description: 'd', agentType: 'scanner', hookFile: 'hooks/x.sh', installMethod: 'manual' },
        { id: '', name: 'No id', description: 'd', agentType: 'scanner', hookFile: 'hooks/y.sh', installMethod: 'manual' }
      ]
    }))
    expect(r.targetExtractors?.accepted).toBe(1)
    expect(r.targetExtractors?.rejected.map((x) => x.name)).toEqual(['broken-cmd', 'bad-strategy'])
    expect(r.commandTags).toMatchObject({ accepted: 1 })
    expect(r.commandTags?.rejected[0].name).toBe('bad-tag')
    expect(r.eventTypes?.accepted).toBe(1)
    expect(r.eventTypes?.rejected[0].name).toBe('(missing agentType)')
    expect(r.capture?.accepted).toBe(1)
    expect(r.capture?.rejected[0].name).toBe('No id')
    removeContributions('allkinds')
  })

  it('names each rejected loot rule and keeps the good ones working', () => {    const r = applyContributions(plugin('mix', { lootPatterns: [
      { type: 'ok', pattern: 'TKT-[0-9]+', name: 'ticket' },
      { type: 'bad', pattern: '([unclosed', name: 'broken' },
      { type: 'grp', pattern: 'a', name: 'neg-group', group: -1 }
    ] }))
    expect(r.lootPatterns?.accepted).toBe(1)
    expect(r.lootPatterns?.rejected.map((x) => x.name)).toEqual(['broken', 'neg-group'])
    expect(r.lootPatterns?.rejected[0].reason).toMatch(/Invalid regular expression/)
    expect(getContributionReport('mix')).toBe(r)
  })

  it('reports zero accepted when every rule is invalid, instead of silence', () => {
    const r = applyContributions(plugin('allbad', { lootPatterns: [{ type: 'x', pattern: '(' }, { type: 'y', pattern: '[' }] }))
    expect(r.lootPatterns).toMatchObject({ accepted: 0 })
    expect(r.lootPatterns?.rejected).toHaveLength(2)
  })

  it('unnamed rules are located by type#index', () => {
    const { rejected } = registerLootPatterns('ut', [{ type: 'a', pattern: 'ok' }, { type: 'b', pattern: '(' }])
    unregisterLootPatterns('ut')
    expect(rejected[0].name).toBe('b#1')
  })

  it('rejects a user tailer whatever its trust status, with a path forward', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const status of ['needs-consent', 'active'] as const) {
        const p = plugin('ut', { tailers: 'code/t.js' }, { tier: 'privileged', status })
        const r = applyContributions(p)
        expect(r.tailers?.state).toBe('rejected')
        expect(r.tailers?.reason).toMatch(/ingest API/)
        expect(tailerUnsupportedReason(p)).toMatch(/not supported/)
      }
    } finally { warn.mockRestore() }
  })

  it('forgets the report when contributions are removed', () => {
    applyContributions(plugin('mix', { lootPatterns: [{ type: 'ok', pattern: 'a' }] }))
    removeContributions('mix')
    expect(getContributionReport('mix')).toBeUndefined()
  })
})

describe('plugins page shows results', () => {
  const t = (k: string, v?: Record<string, string | number>): string =>
    ((en as Record<string, string>)[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''))

  it('lists counts, rejected rule names, apiAhead and a rejected tailer', async () => {
    const view = {
      id: 'p', name: 'P', version: '1', description: '', author: '', source: 'user', tier: 'declarative',
      status: 'active', capabilities: [], contributes: ['lootPatterns'], apiAhead: true,
      report: {
        lootPatterns: { accepted: 1, rejected: [{ name: 'broken', reason: 'Invalid regular expression' }] },
        targetExtractors: { accepted: 2, rejected: [{ name: 'bad-cmd', reason: 'Invalid regular expression' }] },
        commandTags: { accepted: 1, rejected: [] },
        capture: { accepted: 1, rejected: [{ name: 'no-hook', reason: 'needs both `id` and `hookFile`' }] },
        tailers: { state: 'rejected', reason: 'Third-party tailers are not supported' }
      }
    }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: async () => [], list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    // Spec 065: the report lives in the detail panel, not the row.
    fireEvent.click(await screen.findByTestId('plugin-details-p'))
    const box = await screen.findByTestId('plugin-results-p')
    expect(box.textContent).toContain('1 accepted, 1 rejected')
    expect(box.textContent).toContain('broken: Invalid regular expression')
    expect(box.textContent).toContain('newer plugin API')
    expect(box.textContent).toContain('Tailer not running: Third-party tailers are not supported')
    // #348: the kinds that used to register silently now say what took effect.
    expect(screen.getByTestId('plugin-results-targetExtractors-p').textContent).toContain('2 accepted, 1 rejected')
    expect(screen.getByTestId('plugin-results-targetExtractors-p').textContent).toContain('bad-cmd: Invalid regular expression')
    expect(screen.getByTestId('plugin-results-commandTags-p').textContent).toContain('1 accepted, 0 rejected')
    expect(screen.getByTestId('plugin-results-capture-p').textContent).toContain('needs both')
  })

  // #499: terminal profiles report like the other kinds, by name.
  it('lists how many terminal profiles took effect and names the refused ones', async () => {
    const view = {
      id: 'tp', name: 'TP', version: '1', description: '', author: '', source: 'user', tier: 'declarative',
      status: 'active', capabilities: [], contributes: ['terminalProfiles'],
      report: { terminalProfiles: { accepted: 2, rejected: [{ name: 'nc-pty', reason: 'nc is a shipped native default; change it with redlog class add' }] } }
    }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: async () => [], list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    fireEvent.click(await screen.findByTestId('plugin-details-tp'))
    const box = await screen.findByTestId('plugin-results-terminalProfiles-tp')
    expect(box.textContent).toContain('Tool profiles: 2 accepted, 1 rejected')
    expect(box.textContent).toContain('nc-pty: nc is a shipped native default; change it with redlog class add')
  })

  // A plugin awaiting approval contributes no profile; the line says why instead
  // of "0 accepted", which would read as a plugin that offered nothing.
  it('says terminal profiles wait for approval, with no counts', async () => {
    const view = {
      id: 'tw', name: 'TW', version: '1', description: '', author: '', source: 'user', tier: 'privileged',
      status: 'needs-consent', capabilities: [], contributes: ['terminalProfiles'],
      report: { terminalProfiles: { accepted: 0, rejected: [], waiting: true } }
    }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: async () => [], list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    fireEvent.click(await screen.findByTestId('plugin-details-tw'))
    const box = await screen.findByTestId('plugin-results-terminalProfiles-tw')
    expect(box.textContent).toBe('Tool profiles wait for your approval of this plugin.')
  })

  // The docs and the rows beside this one say 工具設定檔 and count with 條.
  it('zh-TW names the terminal profile row like its neighbours', async () => {
    const zh = (await import('../src/renderer/src/i18n/zh-TW.json')).default as Record<string, string>
    expect(zh['plugins.results.terminalProfiles']).toBe('工具設定檔：{{accepted}} 條生效、{{rejected}} 條被拒絕')
    expect(zh['plugins.results.capture']).toContain('條生效')
  })

  it('shows nothing extra for a plugin with no report', async () => {
    const view = { id: 'q', name: 'Q', version: '1', description: '', author: '', source: 'user', tier: 'declarative', status: 'active', capabilities: [], contributes: [], report: null }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: async () => [], list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    await screen.findByText('Q')
    fireEvent.click(screen.getByTestId('plugin-details-q'))
    await screen.findByTestId('plugin-detail-q')
    // No report is not a verdict: the detail says no diagnosis yet, and never
    // draws a results box full of accepted counts.
    expect(screen.queryByTestId('plugin-results-q')).toBeNull()
    expect(screen.getByText(en['plugins.unknownDiagnosis'])).toBeTruthy()
  })
})

describe('redaction rules in the report', () => {
  afterEach(() => { removeContributions('red'); cleanup() })

  it('names a regex entry that does not compile, and keeps the rest', () => {
    const r = applyContributions(plugin('red', { redaction: { denylist: ['/ok[0-9]+/', '/([unclosed/', 'plain'] } }))
    expect(r.redaction?.accepted).toBe(2)
    expect(r.redaction?.rejected.map((x) => `${x.list}:${x.entry}`)).toEqual(['denylist:/([unclosed/'])
    expect(r.redaction?.rejected[0].reason).toMatch(/Invalid regular expression/)
  })

  it('the page lists the rejected entry', async () => {
    const t = (k: string, v?: Record<string, string | number>): string =>
      ((en as Record<string, string>)[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''))
    const view = {
      id: 'r', name: 'R', version: '1', description: '', author: '', source: 'user', tier: 'declarative',
      status: 'active', capabilities: [], contributes: ['redaction'],
      report: { redaction: { accepted: 2, rejected: [{ list: 'denylist', entry: '/(/', reason: 'Invalid regular expression' }] } }
    }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { officialAgents: async () => [], list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    fireEvent.click(await screen.findByTestId('plugin-details-r'))
    const box = await screen.findByTestId('plugin-results-r')
    expect(box.textContent).toContain('Redaction rules: 2 accepted, 1 rejected')
    expect(box.textContent).toContain('denylist: /(/: Invalid regular expression')
  })
})
