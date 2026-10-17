// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

  it('names each rejected loot rule and keeps the good ones working', () => {
    const r = applyContributions(plugin('mix', { lootPatterns: [
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
        tailers: { state: 'rejected', reason: 'Third-party tailers are not supported' }
      }
    }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    const box = await screen.findByTestId('plugin-results-p')
    expect(box.textContent).toContain('1 accepted, 1 rejected')
    expect(box.textContent).toContain('broken: Invalid regular expression')
    expect(box.textContent).toContain('newer plugin API')
    expect(box.textContent).toContain('Tailer not running: Third-party tailers are not supported')
  })

  it('shows nothing extra for a plugin with no report', async () => {
    const view = { id: 'q', name: 'Q', version: '1', description: '', author: '', source: 'user', tier: 'declarative', status: 'active', capabilities: [], contributes: [], report: null }
    ;(window as unknown as { redlog: unknown }).redlog = { plugins: { list: async () => [view], reload: async () => [view] } }
    render(<PluginsPanel t={t} />)
    await screen.findByText('Q')
    expect(screen.queryByTestId('plugin-results-q')).toBeNull()
  })
})
