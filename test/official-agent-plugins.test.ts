import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOfficialAgentPluginManager } from '../src/core/plugins/official-agents'
import { validateManifest, tierOf } from '../src/core/plugins/manifest'

let base: string
let root: string
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'official-agent-')); root = path.join(base, 'plugins') })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true }) })
const manager = () => createOfficialAgentPluginManager(root)
const pluginDir = () => path.join(root, 'official-ai-codex')

describe('official AI capture plugin installation', () => {
  it('lists three uninstalled integrations without creating anything', () => {
    const catalog = manager().list()
    expect(catalog.map(p => p.agentKind)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(catalog.every(p => p.state === 'not-installed')).toBe(true)
    expect(fs.existsSync(root)).toBe(false)
  })
  it('installs exactly one declarative manifest, never the AI tool or other adapters', () => {
    expect(manager().install('codex')).toMatchObject({ ok: true, changed: true, pluginId: 'official-ai-codex' })
    expect(fs.readdirSync(root)).toEqual(['official-ai-codex'])
    expect(fs.readdirSync(pluginDir())).toEqual(['plugin.json'])
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir(), 'plugin.json'), 'utf8'))
    const parsed = validateManifest(raw, pluginDir())
    expect(parsed.ok).toBe(true)
    expect(tierOf(parsed.manifest!)).toBe('declarative')
    expect(parsed.manifest!.contributes).toEqual({})
    expect(manager().list().map(p => p.state)).toEqual(['not-installed', 'installed', 'not-installed'])
  })
  it('repeated installation is a no-op', () => {
    manager().install('codex')
    const manifest = path.join(pluginDir(), 'plugin.json')
    const before = fs.statSync(manifest).mtimeMs
    expect(manager().install('codex')).toMatchObject({ ok: true, changed: false })
    expect(fs.statSync(manifest).mtimeMs).toBe(before)
  })
  it('uninstalls only its manifest and leaves existing evidence/configuration untouched', () => {
    const project = path.join(base, 'project')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'config.yaml'), 'agentTailer: {}\n')
    fs.writeFileSync(path.join(project, 'agent-transcript.jsonl'), 'private recorded evidence')
    manager().install('codex')
    expect(manager().uninstall('codex')).toMatchObject({ ok: true, changed: true })
    expect(fs.existsSync(pluginDir())).toBe(false)
    expect(fs.readFileSync(path.join(project, 'config.yaml'), 'utf8')).toBe('agentTailer: {}\n')
    expect(fs.readFileSync(path.join(project, 'agent-transcript.jsonl'), 'utf8')).toBe('private recorded evidence')
  })
  it('removing a missing integration is a no-op and does not create folders', () => {
    expect(manager().uninstall('codex')).toMatchObject({ ok: true, changed: false })
    expect(fs.existsSync(root)).toBe(false)
  })
  it.each(['../codex', 'codex/../../x', 'C:\\tmp', '', null, 1, { id: 'codex' }])('rejects unknown input %j without writing', id => {
    expect(manager().install(id)).toMatchObject({ ok: false })
    expect(manager().uninstall(id)).toMatchObject({ ok: false })
    expect(fs.existsSync(root)).toBe(false)
  })
  it('does not overwrite or remove a user-modified manifest', () => {
    manager().install('codex')
    const manifest = path.join(pluginDir(), 'plugin.json')
    fs.writeFileSync(manifest, '{"id":"my-custom-plugin"}')
    expect(manager().list().find(p => p.agentKind === 'codex')?.state).toBe('conflict')
    expect(manager().install('codex').ok).toBe(false)
    expect(manager().uninstall('codex').ok).toBe(false)
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{"id":"my-custom-plugin"}')
  })
  it('refuses removal when unrecognized extra files are present', () => {
    manager().install('codex')
    fs.writeFileSync(path.join(pluginDir(), 'operator-notes.txt'), 'keep me')
    expect(manager().uninstall('codex').ok).toBe(false)
    expect(fs.readFileSync(path.join(pluginDir(), 'operator-notes.txt'), 'utf8')).toBe('keep me')
    expect(fs.existsSync(path.join(pluginDir(), 'plugin.json'))).toBe(true)
  })
  it('does not adopt an existing foreign directory, even an empty one', () => {
    fs.mkdirSync(pluginDir(), { recursive: true })
    expect(manager().install('codex').ok).toBe(false)
    expect(manager().uninstall('codex').ok).toBe(false)
    expect(fs.readdirSync(pluginDir())).toEqual([])
  })
  it('reports an invalid plugin root as an error rather than uninstalled', () => {
    fs.writeFileSync(root, 'not a directory')
    expect(manager().list().every(p => p.state === 'error' && !!p.error)).toBe(true)
    expect(manager().install('codex').ok).toBe(false)
    expect(fs.readFileSync(root, 'utf8')).toBe('not a directory')
  })
  it.skipIf(process.platform === 'win32')('refuses root, integration-directory and manifest symlinks', () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, root)
    expect(manager().install('codex').ok).toBe(false)
    fs.unlinkSync(root); fs.mkdirSync(root)
    fs.symlinkSync(outside, pluginDir())
    expect(manager().install('codex').ok).toBe(false)
    expect(manager().uninstall('codex').ok).toBe(false)
    fs.unlinkSync(pluginDir())
    manager().install('codex')
    const original = fs.readFileSync(path.join(pluginDir(), 'plugin.json'))
    fs.writeFileSync(path.join(outside, 'plugin.json'), original)
    fs.unlinkSync(path.join(pluginDir(), 'plugin.json'))
    fs.symlinkSync(path.join(outside, 'plugin.json'), path.join(pluginDir(), 'plugin.json'))
    expect(manager().uninstall('codex').ok).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'plugin.json'))).toEqual(original)
  })
  it('reports a partial removal if final directory cleanup fails', () => {
    manager().install('codex')
    const spy = vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => { throw new Error('directory busy') })
    expect(manager().uninstall('codex')).toMatchObject({ ok: false, changed: true, pluginId: 'official-ai-codex', error: 'directory busy' })
    spy.mockRestore()
    expect(fs.existsSync(path.join(pluginDir(), 'plugin.json'))).toBe(false)
    expect(manager().list().find(p => p.agentKind === 'codex')?.state).toBe('conflict')
  })

})
