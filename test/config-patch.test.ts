import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_CONFIG, loadConfig, saveConfig, readConfigRevision, type RedLogConfig } from '../src/core/config'
import {
  applyConfigPatch, diffConfig, rebaseDraft, validateConfigPatch, CONFIG_PATCH_LIMITS, type ConfigPatchOp
} from '../src/core/config-patch'
import { createConfigStore, type ConfigStore } from '../src/main/config-store'
import type { ConfigApplyRequest } from '../src/main/config-apply'
import type { ProjectContext } from '../src/core/project-runtime'

const cfg = (): RedLogConfig => { const c = structuredClone(DEFAULT_CONFIG); c.engagement.id = 'proj-a'; return c }
const valid = (ops: unknown[], extra: Record<string, unknown> = {}): ReturnType<typeof validateConfigPatch> => validateConfigPatch({ ops, ...extra })

describe('config patch: what may be written', () => {
  it('accepts nested fields, whole lists and AI-source keys', () => {
    expect(valid([
      { path: ['network', 'checkInterval'], value: 45, base: 60 },
      { path: ['scope', 'targets'], value: ['a.test', 'b.test'], base: [] },
      { path: ['agentTailer', 'sources', 'claude-code', 'enabled'], value: true, baseAbsent: true },
      { path: ['agentTailer', 'sources', 'codex'], value: { enabled: false, workPaths: ['/w'] } },
      { path: ['scope', 'scopeFile'], value: null },
      { path: ['retention', 'casts'], unset: true }
    ]).ok).toBe(true)
  })

  const refused: Array<[string, unknown]> = [
    ['an unknown field', { path: ['network', 'nope'], value: 1 }],
    ['an unknown section', { path: ['brandNew'], value: 1 }],
    ['a wrong type', { path: ['network', 'checkInterval'], value: '60' }],
    ['a non-finite number', { path: ['network', 'checkInterval'], value: Number.NaN }],
    ['a list of the wrong thing', { path: ['scope', 'targets'], value: ['ok', 3] }],
    ['an enum outside its values', { path: ['network', 'ipMode'], value: 'icmp' }],
    ['an index into a list', { path: ['scope', 'targets', '0'], value: 'x' }],
    ['the project id', { path: ['engagement', 'id'], value: 'other' }],
    ['the current target', { path: ['engagement', 'activeTarget'], value: 'x' }],
    ['the whole engagement', { path: ['engagement'], value: { id: 'x' } }],
    ['__proto__', { path: ['__proto__', 'polluted'], value: true }],
    ['constructor', { path: ['network', 'constructor', 'prototype'], value: {} }],
    ['prototype as a record key', { path: ['agentTailer', 'sources', 'prototype'], value: {} }],
    ['a hostile key inside a value', { path: ['agentTailer', 'sources', 'x'], value: JSON.parse('{"__proto__":{"polluted":true}}') }],
    ['an unknown key inside a value', { path: ['screenshot'], value: { quality: 1, evil: true } }],
    ['an empty path', { path: [], value: 1 }],
    ['a path that is not a list', { path: 'network.checkInterval', value: 1 }],
    ['a deep path', { path: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], value: 1 }]
  ]
  for (const [name, op] of refused) {
    it(`refuses ${name}`, () => {
      expect(valid([op]).ok).toBe(false)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  }

  it('bounds the patch', () => {
    const many = Array.from({ length: CONFIG_PATCH_LIMITS.maxOps + 1 }, () => ({ path: ['network', 'checkInterval'], value: 1 }))
    expect(valid(many)).toEqual({ ok: false, error: 'too many fields in one save' })
    const huge = [{ path: ['scope', 'targets'], value: Array.from({ length: 5000 }, (_, i) => `${'h'.repeat(250)}${i}.test`) }]
    expect(valid(huge)).toEqual({ ok: false, error: 'patch is too large' })
    expect(validateConfigPatch('nope').ok).toBe(false)
    expect(valid([{ path: ['network', 'checkInterval'], value: 1 }], { expectProjectId: 3 }).ok).toBe(false)
  })
})

describe('config patch: applying', () => {
  it('writes nested keys and replaces lists whole, leaving everything else', () => {
    const before = cfg()
    before.scope.targets = ['a.test', 'b.test']
    const { config, conflicts } = applyConfigPatch(before, [
      { path: ['network', 'checkInterval'], value: 45, base: 60 },
      { path: ['scope', 'targets'], value: ['c.test'], base: ['a.test', 'b.test'] }
    ])
    expect(conflicts).toEqual([])
    expect(config.network.checkInterval).toBe(45)
    expect(config.scope.targets).toEqual(['c.test'])
    expect(config.network.blacklist).toEqual(before.network.blacklist)
    expect(before.network.checkInterval).toBe(60) // not modified in place
  })

  it('creates a section that was absent and removes a key on unset', () => {
    const before = cfg()
    delete before.packMembers
    const { config } = applyConfigPatch(before, [
      { path: ['packMembers', 'fileWatcher'], value: true, baseAbsent: true },
      { path: ['retention', 'casts'], unset: true, base: before.retention!.casts }
    ])
    expect(config.packMembers).toEqual({ fileWatcher: true })
    expect(config.retention!.casts).toBeUndefined()
  })

  it('a field changed since the base to something else is a conflict, and nothing is written', () => {
    const disk = cfg()
    disk.network.checkInterval = 90
    const ops: ConfigPatchOp[] = [
      { path: ['loot', 'disabledRules'], value: [], base: ['jwt', 'generic_api_key'] },
      { path: ['network', 'checkInterval'], value: 45, base: 60 }
    ]
    const { config, conflicts } = applyConfigPatch(disk, ops)
    expect(conflicts).toEqual([{ path: ['network', 'checkInterval'], current: 90 }])
    expect(config).toBe(disk)
  })

  it('the same value written elsewhere is not a conflict', () => {
    const disk = cfg()
    disk.network.checkInterval = 45
    expect(applyConfigPatch(disk, [{ path: ['network', 'checkInterval'], value: 45, base: 60 }]).conflicts).toEqual([])
  })

  it('a list another editor changed is a conflict, not a silent replace', () => {
    const disk = cfg()
    disk.scope.targets = ['a.test', 'added-by-targets-view.test']
    const { conflicts } = applyConfigPatch(disk, [{ path: ['scope', 'targets'], value: ['a.test', 'mine.test'], base: ['a.test'] }])
    expect(conflicts).toHaveLength(1)
  })
})

describe('config patch: the renderer side', () => {
  it('diffs to one op per changed leaf, lists whole, with the base value', () => {
    const base = cfg()
    const draft = structuredClone(base)
    draft.network.checkInterval = 45
    draft.scope.targets = ['x']
    draft.packMembers = { fileWatcher: true }
    expect(diffConfig(base, draft)).toEqual([
      { path: ['network', 'checkInterval'], value: 45, base: 60 },
      { path: ['scope', 'targets'], value: ['x'], base: [] },
      { path: ['packMembers'], value: { fileWatcher: true }, baseAbsent: true }
    ])
    expect(diffConfig(base, structuredClone(base))).toEqual([])
  })

  it('rebases a draft: takes what changed elsewhere, keeps its own edits and their old base', () => {
    const baseline = cfg()
    const draft = structuredClone(baseline)
    draft.network.checkInterval = 45
    const fresh = structuredClone(baseline)
    fresh.scope.targets = ['elsewhere.test']
    fresh.network.checkInterval = 90
    const r = rebaseDraft(baseline, draft, fresh)
    expect(r.draft.scope.targets).toEqual(['elsewhere.test'])
    expect(r.draft.network.checkInterval).toBe(45)
    // So the next save of it is still a conflict against the 90.
    expect(r.baseline.network.checkInterval).toBe(60)
    expect(r.baseline.scope.targets).toEqual(['elsewhere.test'])
  })
})

// ─── main's writer, against a real config.yaml ──────────────────────────────

describe('config store', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const ctx: ProjectContext = { projectId: 'p', engagementId: 'proj-a', operatorId: 'operator-1', generation: 1, signal: new AbortController().signal }
  function setup(): { dir: string; store: ConfigStore; applied: ConfigApplyRequest[]; bytes: () => string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-store-'))
    dirs.push(dir)
    saveConfig(dir, cfg())
    const applied: ConfigApplyRequest[] = []
    const store = createConfigStore({
      projectDir: () => dir, identity: () => ctx,
      resolveOperator: (_prev, next) => next,
      apply: (r) => { applied.push(r) }
    })
    return { dir, store, applied, bytes: () => fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8') }
  }
  /** A page's baseline: what config:get returned when it loaded. */
  const pageLoads = (dir: string): RedLogConfig => loadConfig(dir)
  const otherWriter = (dir: string, mut: (c: RedLogConfig) => void): void => { const c = loadConfig(dir); mut(c); saveConfig(dir, c) }

  it('lost update: a field changed after the page loaded survives the page saving another', () => {
    const { dir, store } = setup()
    const page = pageLoads(dir)
    otherWriter(dir, (c) => { c.scope.targets = ['added-elsewhere.test'] })
    const draft = structuredClone(page)
    draft.network.checkInterval = 45
    const res = store.patch({ ops: diffConfig(page, draft), expectProjectId: 'proj-a' })
    expect(res.ok).toBe(true)
    const after = loadConfig(dir)
    expect(after.network.checkInterval).toBe(45)
    expect(after.scope.targets).toEqual(['added-elsewhere.test'])
  })

  it('conflict: both changed the same field — typed result, the file keeps the other value', () => {
    const { dir, store, applied, bytes } = setup()
    const page = pageLoads(dir)
    otherWriter(dir, (c) => { c.network.checkInterval = 90 })
    const before = bytes()
    const draft = structuredClone(page)
    draft.network.checkInterval = 45
    const res = store.patch({ ops: diffConfig(page, draft) })
    expect(res).toMatchObject({ ok: false, reason: 'conflict', conflicts: [{ path: ['network', 'checkInterval'], current: 90 }] })
    expect(res.ok === false && res.reason === 'conflict' && (res.config as RedLogConfig).network.checkInterval).toBe(90)
    expect(bytes()).toBe(before)
    expect(applied).toEqual([])
  })

  it('the same value is no conflict', () => {
    const { dir, store } = setup()
    const page = pageLoads(dir)
    otherWriter(dir, (c) => { c.network.checkInterval = 45 })
    const draft = structuredClone(page)
    draft.network.checkInterval = 45
    expect(store.patch({ ops: diffConfig(page, draft) }).ok).toBe(true)
  })

  it('the revision moves on every save that changes the file, and not on one that does not', () => {
    const { dir, store } = setup()
    const r0 = readConfigRevision(dir)
    const a = store.patch({ ops: [{ path: ['network', 'checkInterval'], value: 1, base: 60 }] })
    const b = store.patch({ ops: [{ path: ['network', 'checkInterval'], value: 2, base: 1 }] })
    const same = store.patch({ ops: [{ path: ['network', 'checkInterval'], value: 2, base: 2 }] })
    if (!a.ok || !b.ok || !same.ok) throw new Error('save failed')
    expect(new Set([r0, a.revision, b.revision]).size).toBe(3)
    expect(same.revision).toBe(b.revision)
    expect(readConfigRevision(dir)).toBe(b.revision)
  })

  it('a patch that fails validation leaves the file untouched', () => {
    const { store, applied, bytes } = setup()
    const before = bytes()
    const res = store.patch({ ops: [{ path: ['network', 'checkInterval'], value: 1 }, { path: ['__proto__', 'x'], value: 1 }] })
    expect(res).toMatchObject({ ok: false, reason: 'invalid' })
    expect(bytes()).toBe(before)
    expect(applied).toEqual([])
  })

  it('expectProjectId refuses a save meant for another project', () => {
    const { store, bytes } = setup()
    const before = bytes()
    expect(store.patch({ ops: [{ path: ['network', 'checkInterval'], value: 1 }], expectProjectId: 'proj-b' })).toEqual({ ok: false, reason: 'wrong-project' })
    expect(store.saveWhole({ ...cfg(), network: { ...cfg().network, checkInterval: 1 } }, { expectProjectId: 'proj-b' })).toBe(false)
    expect(bytes()).toBe(before)
  })

  it('applies through the apply path, describing the change from the file as it was', () => {
    const { store, applied } = setup()
    store.patch({ ops: [{ path: ['loot', 'disabledRules'], value: [], base: ['jwt', 'generic_api_key'] }] })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ reason: 'save', identity: ctx })
    expect(applied[0].diskPrev?.loot?.disabledRules).toEqual(['jwt', 'generic_api_key'])
    expect(applied[0].next.loot?.disabledRules).toEqual([])
  })

  it('the whole-object save writes what differs, ignores the engagement, and validates', () => {
    const { dir, store } = setup()
    const whole = { ...cfg(), engagement: { id: 'hijack', activeTarget: 'x' }, network: { ...cfg().network, checkInterval: 7 } }
    expect(store.saveWhole(whole)).toBe(true)
    const after = loadConfig(dir)
    expect(after.network.checkInterval).toBe(7)
    expect(after.engagement).toEqual({ id: 'proj-a', activeTarget: null })
    expect(store.saveWhole({ ...cfg(), network: { ...cfg().network, checkInterval: 'seven' } })).toBe(false)
    expect(loadConfig(dir).network.checkInterval).toBe(7)
  })

  it('no project open: refused', () => {
    const store = createConfigStore({ projectDir: () => null, identity: () => null, resolveOperator: (_p, n) => n, apply: () => {} })
    expect(store.patch({ ops: [] })).toEqual({ ok: false, reason: 'no-project' })
  })
})
