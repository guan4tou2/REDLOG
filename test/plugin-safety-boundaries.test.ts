import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Four boundaries of the plugin system (docs/records/2026-11-12/root-cause/
// 08-plugin-system.md F3, F4, F7):
//   1. a plugin in ~/.redlog/plugins cannot take a bundled plugin's id;
//   2. a missing dependency is named from the manifest's lists, not its prose;
//   3. a plugin's commands are shown only for the content that was approved;
//   4. a hook RedLog wrote can be removed after its plugin stops loading.
// Every store lives under a temp HOME; each test gets fresh module state.

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const REPO_PLUGINS = path.join(__dirname, '..', 'plugins')

let home: string
let prev: { h?: string; u?: string; r?: string; shell?: string }

function writePlugin(dirName: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = path.join(home, '.redlog', 'plugins', dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const manual = (over: Record<string, unknown> = {}) => ({
  id: 'run', name: 'Runner', description: 'needs tcpdump', agentType: 'scanner',
  hookFile: 'hook.sh', installMethod: 'manual',
  manualSteps: [{ label: 'Start it', command: 'sudo "{hookFile}" eth0' }], ...over
})
const withCapture = (id: string, entries: unknown[]) => ({
  id, name: id, version: '1.0.0', redlogApi: 1, contributes: { capture: entries }
})
const HOOK = { 'hook.sh': '#!/bin/sh\n' }

async function fresh() {
  vi.resetModules()
  const plugins = await import('../src/core/plugins')
  const loader = await import('../src/core/plugins/loader')
  const hooks = await import('../src/core/hooks-manager')
  const trust = await import('../src/core/plugins/trust')
  const state = await import('../src/core/plugins/state')
  const targets = await import('../src/core/target-extractor')
  return { plugins, loader, hooks, trust, state, targets }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plugsafe-'))
  prev = { h: process.env.HOME, u: process.env.USERPROFILE, r: process.resourcesPath, shell: process.env.SHELL }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.SHELL = '/bin/zsh'
})
afterEach(() => {
  const restore = (k: 'HOME' | 'USERPROFILE' | 'SHELL', v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  restore('HOME', prev.h); restore('USERPROFILE', prev.u); restore('SHELL', prev.shell)
  ;(process as { resourcesPath?: string }).resourcesPath = prev.r
  fs.rmSync(home, { recursive: true, force: true })
})

describe('1. a user plugin cannot replace a bundled plugin by id', () => {
  it('the bundled plugin loads, and the colliding folder is a failed row of its own', async () => {
    const dir = writePlugin('builtin-tools', { id: 'builtin-tools', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
    const { loader } = await fresh()
    const all = loader.loadPlugins()

    const bundled = all.filter((p) => p.manifest.id === 'builtin-tools')
    expect(bundled).toHaveLength(1)
    expect(bundled[0].source).toBe('bundled')
    expect(bundled[0].status).toBe('active')

    const refused = all.find((p) => p.dir === dir)
    expect(refused, 'the colliding plugin must not disappear').toBeTruthy()
    expect(refused!.status).toBe('error')
    expect(refused!.error).toMatch(/reserved by a built-in plugin/)
    expect(refused!.manifest.id).not.toBe('builtin-tools')
    // Every consumer keys by id: Maps, React keys, the trust and state stores.
    const ids = all.map((p) => p.manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a folder of another name that declares a bundled id is refused the same way', async () => {
    const dir = writePlugin('my-pcap', withCapture('pcap-capture', [manual()]), HOOK)
    const { loader } = await fresh()
    const all = loader.loadPlugins()
    expect(all.find((p) => p.manifest.id === 'pcap-capture')?.source).toBe('bundled')
    expect(all.find((p) => p.dir === dir)?.status).toBe('error')
  })

  it('a broken manifest in a folder named after a bundled id does not take the bundled one down', async () => {
    const dir = path.join(home, '.redlog', 'plugins', 'builtin-tools')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{ not json')
    const { loader } = await fresh()
    const all = loader.loadPlugins()
    expect(all.find((p) => p.manifest.id === 'builtin-tools')?.source).toBe('bundled')
    const broken = all.find((p) => p.dir === dir)
    expect(broken?.status).toBe('error')
    const ids = all.map((p) => p.manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the bundled rules stay applied, and the colliding plugin inherits no trust grant or disable flag', async () => {
    writePlugin('builtin-tools', withCapture('builtin-tools', [manual()]), HOOK)
    const { plugins, trust, state, targets, loader } = await fresh()
    // A grant and a disable recorded under the bundled id must reach neither
    // the bundled plugin's replacement nor anything it contributes.
    const userCopy = loader.loadPlugins().find((p) => p.source === 'user')!
    trust.grant('builtin-tools', userCopy.contentHash, [])
    plugins.initPlugins()
    expect(targets.extractTargetWithProvenance('nmap -sV 10.0.0.1').host).toBe('10.0.0.1')
    const refused = plugins.listPlugins().find((p) => p.source === 'user')!
    expect(refused.status).toBe('error')
    expect(plugins.grantPluginTrust(refused.manifest.id).ok).toBe(false)
    state.setDisabled(refused.manifest.id, true)
    plugins.reloadPlugins()
    expect(plugins.listPlugins().find((p) => p.manifest.id === 'builtin-tools')?.status).toBe('active')
    expect(targets.extractTargetWithProvenance('nmap -sV 10.0.0.1').host).toBe('10.0.0.1')
  })
})

describe('2. a missing dependency is named from the manifest, not its description', () => {
  it('reports the requiresAll and requires entries that are not on PATH', async () => {
    const { hooks } = await fresh()
    hooks.registerCapturePlugins('dep', '/tmp/dep', [{
      id: 'cap', name: 'Cap', description: 'needs tcpdump', agentType: 'scanner', installMethod: 'manual',
      hookFile: 'hook.sh', requires: ['redlog-no-such-tool-a'], requiresAll: ['redlog-no-such-tool-b']
    }])
    const row = hooks.detectHooks().find((h) => h.id === 'dep.cap')!
    expect(row.available).toBe(false)
    expect(row.missing).toEqual(['redlog-no-such-tool-b', 'redlog-no-such-tool-a'])
    const asyncRow = (await hooks.detectHooksAsync()).find((h) => h.id === 'dep.cap')!
    expect(asyncRow.missing).toEqual(['redlog-no-such-tool-b', 'redlog-no-such-tool-a'])
  })

  it('validates requiresAll as a list of text', async () => {
    const { validateManifest } = await import('../src/core/plugins/manifest')
    const dir = writePlugin('vv', {}, HOOK)
    expect(validateManifest(withCapture('vv', [manual({ requiresAll: 'node' })]), dir).ok).toBe(false)
    expect(validateManifest(withCapture('vv', [manual({ requiresAll: ['node'] })]), dir).ok).toBe(true)
  })

  it('the bundled pcap capture declares node as all-of, apart from its any-of capture tool', () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO_PLUGINS, 'pcap-capture', 'plugin.json'), 'utf-8'))
    const byHook = (f: string) => m.contributes.capture.find((c: { hookFile: string }) => c.hookFile === f)
    expect(byHook('hooks/pcap-capture.sh')).toMatchObject({ requires: ['tcpdump'], requiresAll: ['node'] })
    expect(byHook('hooks/pcap-capture.ps1')).toMatchObject({ requires: ['tshark'], requiresAll: ['node'] })
  })

  it('no renderer or core code reads a dependency out of a description', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name)) continue
        if (/description\??\.(match|includes|test|search|startsWith|endsWith)\(/.test(fs.readFileSync(p, 'utf-8'))) offenders.push(p)
      }
    }
    walk(path.join(__dirname, '..', 'src'))
    expect(offenders).toEqual([])
  })
})

describe('3. commands are shown only for the content that was approved', () => {
  it('an unapproved user plugin\'s steps are withheld, not shown', async () => {
    writePlugin('steps', withCapture('steps', [manual()]), HOOK)
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    expect(plugins.listPlugins().find((p) => p.manifest.id === 'steps')?.status).toBe('needs-consent')
    const row = hooks.detectHooks().find((h) => h.id === 'steps.run')!
    expect(row, 'the row stays, so the operator can see it needs approval').toBeTruthy()
    expect(row.manualSteps).toBeUndefined()
    expect(row.stepsWithheld).toBe('needs-consent')
  })

  it('after approval the steps name the exact file that was hashed', async () => {
    const dir = writePlugin('steps', withCapture('steps', [manual()]), HOOK)
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    expect(plugins.grantPluginTrust('steps').ok).toBe(true)
    const row = hooks.detectHooks().find((h) => h.id === 'steps.run')!
    expect(row.stepsWithheld).toBeUndefined()
    expect(row.manualSteps?.[0].command).toBe(`sudo "${path.join(dir, 'hook.sh')}" eth0`)
  })

  it('a hook file changed after approval withdraws the command at once, and the next load says hash-changed', async () => {
    const dir = writePlugin('steps', withCapture('steps', [manual()]), HOOK)
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    expect(plugins.grantPluginTrust('steps').ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'hook.sh'), '#!/bin/sh\nid > /tmp/owned\n')
    hooks.invalidateHooksCache()
    const row = hooks.detectHooks().find((h) => h.id === 'steps.run')!
    expect(row.manualSteps).toBeUndefined()
    expect(row.stepsWithheld).toBe('hash-changed')
    expect((await hooks.detectHooksAsync()).find((h) => h.id === 'steps.run')!.manualSteps).toBeUndefined()
    plugins.reloadPlugins()
    expect(plugins.listPlugins().find((p) => p.manifest.id === 'steps')?.status).toBe('hash-changed')
    expect(hooks.detectHooks().find((h) => h.id === 'steps.run')!.stepsWithheld).toBe('hash-changed')
  })

  it('the cached detection answered before a refresh does not carry a withdrawn command', async () => {
    const dir = writePlugin('steps', withCapture('steps', [manual()]), HOOK)
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    expect(plugins.grantPluginTrust('steps').ok).toBe(true)
    await hooks.detectHooksAsync()
    expect(hooks.getCachedHooks()!.find((h) => h.id === 'steps.run')!.manualSteps).toBeTruthy()
    fs.writeFileSync(path.join(dir, 'hook.sh'), '#!/bin/sh\nid > /tmp/owned\n')
    const cached = hooks.getCachedHooks()!.find((h) => h.id === 'steps.run')!
    expect(cached.manualSteps).toBeUndefined()
    expect(cached.stepsWithheld).toBe('hash-changed')
  })

  it('a bundled hook file changed after RedLog loaded it withdraws its commands', async () => {
    const res = path.join(home, 'resources')
    fs.cpSync(path.join(REPO_PLUGINS, 'pcap-capture'), path.join(res, 'plugins', 'pcap-capture'), { recursive: true })
    ;(process as { resourcesPath?: string }).resourcesPath = res
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    const before = hooks.detectHooks().find((h) => h.id === 'pcap-capture.pcap-tcpdump')!
    expect(before.manualSteps?.some((s) => s.command?.includes('sudo'))).toBe(true)
    fs.appendFileSync(path.join(res, 'plugins', 'pcap-capture', 'hooks', 'pcap-capture.sh'), '\nid > /tmp/owned\n')
    const after = hooks.detectHooks().find((h) => h.id === 'pcap-capture.pcap-tcpdump')!
    expect(after.manualSteps).toBeUndefined()
    expect(after.stepsWithheld).toBe('bundled-changed')
  })

  it('a user plugin whose steps carry no command needs no approval', async () => {
    writePlugin('labels', withCapture('labels', [manual({ manualSteps: [{ label: 'Read the README' }] })]), HOOK)
    const { plugins, hooks } = await fresh()
    plugins.initPlugins()
    expect(plugins.listPlugins().find((p) => p.manifest.id === 'labels')?.status).toBe('active')
    expect(hooks.detectHooks().find((h) => h.id === 'labels.run')!.manualSteps).toEqual([{ label: 'Read the README', command: undefined }])
  })
})

describe.skipIf(process.platform === 'win32')('4. a hook can be removed after its plugin stops loading', () => {
  const shellCap = { id: 'sh', name: 'Acme shell', description: 'd', agentType: 'shell', hookFile: 'hook.sh', installMethod: 'shell-source', shellRcFile: '.zshrc' }
  const claudeCap = { id: 'cc', name: 'Acme claude', description: 'd', agentType: 'agent', hookFile: 'hook.sh', installMethod: 'claude-settings' }
  const rc = () => fs.readFileSync(path.join(home, '.zshrc'), 'utf-8')
  const settings = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'))

  async function installed() {
    fs.writeFileSync(path.join(home, '.zshrc'), '# mine\n')
    const dir = writePlugin('acme', withCapture('acme', [shellCap, claudeCap]), HOOK)
    const m = await fresh()
    m.plugins.initPlugins()
    expect(m.plugins.grantPluginTrust('acme').ok).toBe(true)
    expect(m.hooks.installHook('acme.sh').success).toBe(true)
    expect(m.hooks.installHook('acme.cc').success).toBe(true)
    expect(rc()).toContain('# RedLog shell hook')
    expect(JSON.stringify(settings())).toContain(path.join(dir, 'hook.sh'))
    return { dir, ...m }
  }

  it('after a revoke, uninstall still removes RedLog\'s own lines and says where', async () => {
    const { plugins, hooks } = await installed()
    plugins.revokePluginTrust('acme')
    const sh = hooks.uninstallHook('acme.sh')
    expect(sh.success).toBe(true)
    expect(sh.message).toContain('.zshrc')
    expect(rc()).toBe('# mine\n')
    const cc = hooks.uninstallHook('acme.cc')
    expect(cc.success).toBe(true)
    expect(cc.message).toContain('settings.json')
    expect(settings().hooks.PostToolUse).toEqual([])
  })

  it('after a restart with the plugin disabled, uninstall reads the manifest from its folder', async () => {
    await installed()
    const m = await fresh()
    m.state.setDisabled('acme', true)
    m.plugins.initPlugins()
    expect(m.hooks.uninstallHook('acme.sh').success).toBe(true)
    expect(rc()).toBe('# mine\n')
    expect(m.hooks.uninstallHook('acme.cc').success).toBe(true)
    expect(settings().hooks.PostToolUse).toEqual([])
  })

  it('with the starter pack switched off, a built-in shell hook can still be removed', async () => {
    const m = await fresh()
    expect(m.hooks.installHook('shell-bash').success).toBe(true)
    m.state.setDisabled('starter-pack', true)
    const r = m.hooks.uninstallHook('shell-bash')
    expect(r.message).not.toMatch(/Unknown plugin/)
    expect(r.success).toBe(true)
    const bashrc = path.join(home, '.bashrc')
    expect(fs.existsSync(bashrc) ? fs.readFileSync(bashrc, 'utf-8') : '').not.toContain('# RedLog shell hook')
  })

  it('with the folder gone, uninstall names the exact files and lines instead of "Unknown plugin"', async () => {
    const { dir } = await installed()
    fs.rmSync(dir, { recursive: true, force: true })
    const m = await fresh()
    m.plugins.initPlugins()
    const r = m.hooks.uninstallHook('acme.sh')
    expect(r.success).toBe(false)
    expect(r.message).not.toMatch(/Unknown plugin/)
    const text = JSON.stringify(r)
    expect(text).toContain(path.join(home, '.zshrc'))
    expect(text).toContain(`source ${path.join(home, '.redlog', 'hook.sh')}`)
    expect(text).toContain(path.join(home, '.claude', 'settings.json'))
    expect(text).toContain(path.join(dir, 'hook.sh'))
    // Nothing is removed on a guess.
    expect(rc()).toContain('# RedLog shell hook')
  })
})
