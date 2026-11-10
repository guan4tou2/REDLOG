import { matchesQuery } from '../src/renderer/src/lib/textQuery'
import { describe, it, expect } from 'vitest'
import {
  effectGroups, attentionIssues, needsAttention, cannotBeTrusted,
  pluginSearchText, pluginViewModel
} from '../src/renderer/src/lib/pluginViewModel'
import type { PluginView } from '../src/renderer/src/lib/pluginViewModel'

const view = (over: Partial<PluginView>): PluginView => ({
  id: 'p', name: 'Plugin p', version: '1.0.0', description: 'a demo', author: 'me',
  source: 'user', tier: 'declarative', status: 'active', capabilities: [], contributes: [], ...over
})

describe('effectGroups', () => {
  it('returns nothing when the report is null — no diagnosis is not a verdict', () => {
    expect(effectGroups(view({ report: null }))).toEqual([])
  })
  it('normalises every group with counts and rejected titles', () => {
    const p = view({
      report: {
        lootPatterns: { accepted: 2, rejected: [{ name: 'loose-aws', reason: 'ambiguous' }] },
        targetExtractors: { accepted: 1, rejected: [] },
        redaction: { accepted: 0, rejected: [{ list: 'default', entry: 'AKIA.*', reason: 'overbroad' }] },
        capture: { accepted: 0, rejected: [], waiting: true }
      }
    })
    const groups = effectGroups(p)
    const byKey = (key: string) => groups.find((g) => g.key === key)
    expect(groups).toHaveLength(4)
    expect(byKey('loot')).toMatchObject({ labelKey: 'plugins.results.loot', accepted: 2, rejected: [{ title: 'loose-aws', reason: 'ambiguous' }] })
    expect(byKey('targetExtractors')?.rejected).toEqual([])
    expect(byKey('redaction')?.rejected).toEqual([{ title: 'default: AKIA.*', reason: 'overbroad' }])
    expect(byKey('capture')?.waiting).toBe(true)
  })
  it('represents a refused tailer as one issue line, not an accepted count', () => {
    const p = view({ report: { tailers: { state: 'rejected', reason: 'Third-party tailers are not supported' } } })
    expect(effectGroups(p)).toEqual([
      { key: 'tailers', labelKey: 'plugins.results.tailerRejected', accepted: 0, rejected: [{ title: '', reason: 'Third-party tailers are not supported' }] }
    ])
  })
})

describe('needs attention', () => {
  it('is empty for a clean, active, undiagnosed plugin', () => {
    const p = view({ status: 'active', report: null })
    expect(attentionIssues(p)).toEqual([])
    expect(needsAttention(p)).toBe(false)
  })
  it('never calls a deliberate disable an issue', () => {
    expect(attentionIssues(view({ status: 'disabled' }))).toEqual([])
  })
  it('lists load error first and profiles-stale last', () => {
    const issues = attentionIssues(view({ status: 'error', error: 'bad manifest', apiAhead: true, report: { lootPatterns: { accepted: 0, rejected: [{ name: 'r', reason: 'x' }] } }, profilesError: 'EBUSY' }))
    expect(issues.map((i) => i.kind)).toEqual(['error', 'api-ahead', 'partially-effective', 'profiles-stale'])
  })
  it('flags the three approval states by their own kind', () => {
    expect(attentionIssues(view({ status: 'needs-consent', report: null }))[0]?.kind).toBe('needs-consent')
    expect(attentionIssues(view({ status: 'hash-changed', report: null }))[0]?.kind).toBe('hash-changed')
  })
  it('flags waiting installs and partially rejected contributions', () => {
    expect(attentionIssues(view({ report: { capture: { accepted: 0, rejected: [], waiting: true } } })).map((i) => i.kind)).toContain('partially-effective')
    expect(attentionIssues(view({ report: { commandTags: { accepted: 1, rejected: [{ name: 't', reason: 'r' }] } } })).map((i) => i.kind)).toContain('partially-effective')
  })
})

describe('cannotBeTrusted', () => {
  it('refuses a user tailer with nothing else to approve', () => {
    expect(cannotBeTrusted(view({ source: 'user', report: { tailers: { state: 'rejected' } } }))).toBe(true)
  })
  it('leaves profiles of the same plugin approachable', () => {
    expect(cannotBeTrusted(view({ source: 'user', report: { tailers: { state: 'rejected' } }, terminalProfiles: [{ name: 'vim', mode: 'native', executables: ['vim'], reason: 'r' }] }))).toBe(false)
  })
  it('never refuses a bundled tailer', () => {
    expect(cannotBeTrusted(view({ source: 'bundled', report: { tailers: { state: 'accepted' } } }))).toBe(false)
  })
})

describe('search', () => {
  const p = view({
    description: 'azure loot', capabilities: ['read:events'], contributes: ['lootPatterns'],
    name: 'recon-pack', author: 'acme', id: 'recon'
  })
  const text = pluginSearchText(p, () => p.description)
  it('matches every searchable field, case-insensitively', () => {
    for (const q of ['recon', 'RECON-PACK', 'acme', 'azure', 'read:events', 'lootPatterns']) {
      expect(matchesQuery(text, q)).toBe(true)
    }
  })
  it('matches the translated describe() line, so builtin packs are findable in Chinese', () => {
    const t = pluginSearchText(view({ description: '' }), () => '偵測 AWS 金鑰')
    expect(matchesQuery(t, '金鑰')).toBe(true)
  })
  it('requires every whitespace-separated term (AND)', () => {
    expect(matchesQuery(text, 'recon acme')).toBe(true)
    expect(matchesQuery(text, 'recon nope')).toBe(false)
  })
  it('matches everything on an empty query', () => {
    expect(matchesQuery(text, '   ')).toBe(true)
  })
})

describe('pluginViewModel', () => {
  it('keys by plugin id; an official integration is managed as one, an ordinary plugin from the folder', () => {
    const official = pluginViewModel(view({ tier: 'privileged', status: 'active', needsApproval: true, officialAgent: true, official: { agentKind: 'codex', state: 'installed' } }), () => '')
    expect(official.pluginId).toBe('p')
    expect(official.trust.canRevoke).toBe(true)
    expect(official.install.managedBy).toBe('officialIntegration')
    expect(pluginViewModel(view({}), () => '').install.managedBy).toBe('pluginFolder')
  })
  it('flags needs-consent and hash-changed together as the trust axis sees them', () => {
    for (const status of ['needs-consent', 'hash-changed'] as const) {
      const vm = pluginViewModel(view({ tier: 'privileged', status }), () => '')
      expect(vm.trust.needsConsent).toBe(true)
      expect(vm.trust.canRevoke).toBe(false)
    }
    expect(pluginViewModel(view({ status: 'active' }), () => '').trust.needsConsent).toBe(false)
  })
})