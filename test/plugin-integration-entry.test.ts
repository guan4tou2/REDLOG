import { describe, it, expect } from 'vitest'
import {
  mergeOfficialCatalog, pluginViewModel, attentionIssues, officialProjectLevel, officialHealth,
  type PluginView
} from '../src/renderer/src/lib/pluginViewModel'

// Spec 066 batch B: the official-integration catalog merges into the plugin
// list by pluginId, so a not-installed integration has a row of its own and is
// never drawn as "disabled".

const view = (id: string, over: Record<string, unknown> = {}): PluginView => ({
  id, name: `Plugin ${id}`, version: '1.0.0', description: '', author: 'me', source: 'bundled',
  tier: 'declarative', status: 'active', capabilities: [], contributes: [], ...over
}) as PluginView
const entry = (kind: string, state: string, over: Record<string, unknown> = {}) => ({
  agentKind: kind, pluginId: `agent-${kind}`, name: `Agent ${kind}`, source: {} as never, state, ...over
}) as never
const describeAny = (p: PluginView): string => p.description

describe('mergeOfficialCatalog (FR-001, FR-004, FR-006)', () => {
  it('adds a row for a not-installed integration and never shows it as disabled or trusted', () => {
    const merged = mergeOfficialCatalog([view('alpha', { source: 'user' })], [entry('codex', 'not-installed')])
    expect(merged.map((p) => p.id)).toEqual(['alpha', 'agent-codex'])
    const stub = merged[1]
    expect(stub.notLoaded).toBe(true)
    const vm = pluginViewModel(stub, describeAny)
    expect(vm.install.official?.state).toBe('not-installed')
    expect(vm.trust.applicable).toBe(false)
    expect(vm.issues).toEqual([])
  })
  it('merges an installed integration into the one row with the same id, without a duplicate', () => {
    const merged = mergeOfficialCatalog([view('agent-codex')], [entry('codex', 'installed', { installationId: 'i1' })])
    expect(merged).toHaveLength(1)
    expect(merged[0].notLoaded).toBeUndefined()
    expect(merged[0].official).toMatchObject({ agentKind: 'codex', state: 'installed', installationId: 'i1' })
    expect(pluginViewModel(merged[0], describeAny).trust.applicable).toBe(true)
  })
  it('leaves ordinary plugins untouched', () => {
    const p = view('alpha', { source: 'user' })
    expect(mergeOfficialCatalog([p], [])[0]).toBe(p)
  })
})

describe('install axis (FR-002, FR-005)', () => {
  it.each([
    ['conflict', 'plugins.issue.officialConflict'],
    ['error', 'plugins.issue.officialError'],
    ['update-available', 'plugins.issue.officialUpdate']
  ])('%s counts as needing attention', (state, key) => {
    const [row] = mergeOfficialCatalog([], [entry('codex', state, { error: 'boom' })])
    expect(attentionIssues(row).map((i) => i.labelKey)).toContain(key)
    const vm = pluginViewModel(row, describeAny)
    expect(vm.install.official).toMatchObject({ state, error: 'boom' })
  })
  it('installed and not-installed need no attention', () => {
    for (const state of ['installed', 'not-installed']) {
      const [row] = mergeOfficialCatalog([], [entry('codex', state)])
      expect(attentionIssues(row)).toEqual([])
    }
  })
})

describe('project level (FR-033)', () => {
  const row = (state: string, status = 'active') => mergeOfficialCatalog([view('agent-codex', { status })], [entry('codex', state, { installationId: 'i1' })])[0]
  it('is separate from health and says what the operator can act on', () => {
    expect(officialProjectLevel(row('installed'), { enabled: true, installationId: 'i1' })).toBe('recording')
    expect(officialProjectLevel(row('installed'), { enabled: false, installationId: 'i1' })).toBe('installedNotEnabled')
    expect(officialProjectLevel(row('installed'), { enabled: true, installationId: 'other' })).toBe('installedNotEnabled')
    expect(officialProjectLevel(row('installed', 'disabled'), { enabled: true, installationId: 'i1' })).toBe('installedNotEnabled')
    expect(officialProjectLevel(row('installed'), undefined)).toBe('unknown')
    expect(officialProjectLevel(mergeOfficialCatalog([], [entry('codex', 'not-installed')])[0], { enabled: true })).toBe('notInstalled')
    expect(officialProjectLevel(row('conflict'), { enabled: true })).toBe('unavailable')
  })
})

describe('health (FR-030–032)', () => {
  const installed = mergeOfficialCatalog([view('agent-codex')], [entry('codex', 'installed')])[0]
  const absent = mergeOfficialCatalog([], [entry('codex', 'not-installed')])[0]
  it('a failed read is unknown, never reusing the previous verdict', () => {
    expect(officialHealth(installed, 'recording', { status: 'unknown', source: { lastEventAt: 5, lastError: { message: 'x' } } })).toEqual({ kind: 'unknown' })
  })
  it('an error shows its message; a delivery shows its time', () => {
    expect(officialHealth(installed, 'recording', { status: 'ok', source: { lastEventAt: 5, lastError: { message: 'bad' } } })).toEqual({ kind: 'error', message: 'bad' })
    expect(officialHealth(installed, 'recording', { status: 'ok', source: { lastEventAt: 5 } })).toEqual({ kind: 'received', at: 5 })
  })
  it('no events is not a fault: not installed or not enabled is inactive, enabled is waiting', () => {
    expect(officialHealth(absent, 'notInstalled', { status: 'ok', source: { lastEventAt: null } })).toEqual({ kind: 'inactive' })
    expect(officialHealth(installed, 'installedNotEnabled', { status: 'ok', source: { lastEventAt: null } })).toEqual({ kind: 'inactive' })
    expect(officialHealth(installed, 'recording', { status: 'ok', source: { lastEventAt: null } })).toEqual({ kind: 'waiting' })
  })
  it('no snapshot at all is unknown', () => {
    expect(officialHealth(installed, 'recording', { status: 'ok', source: undefined }).kind).toBe('unknown')
  })
})
