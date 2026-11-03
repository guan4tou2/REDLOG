import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// #499: a plugin that installs something on the operator's machine is gated on
// the operator's approval of its exact content, and what it may name as an
// install location is a short fixed list. Plugin redaction can only add to what
// is masked. Every plugin store lives under a temp home.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

import { validateManifest, requiresApproval } from '../src/core/plugins/manifest'
import { loadPlugins } from '../src/core/plugins/loader'
import { initPlugins, grantPluginTrust, revokePluginTrust, listPlugins } from '../src/core/plugins'
import { getContributionReport } from '../src/core/plugins/contributions'
import { registerCapturePlugins, unregisterCapturePlugins, getHookInstallPlan, installHook } from '../src/core/hooks-manager'
import { registerRedactionRules, unregisterRedactionRules, getRules, redact } from '../src/core/redaction'

let realHome: string | undefined
let realUserProfile: string | undefined
let tmp: string

function writePlugin(id: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = path.join(tmp, '.redlog', 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const capture = (over: Record<string, unknown> = {}) => ({
  id: 'hook', name: 'Hook', description: 'd', agentType: 'shell', hookFile: 'hook.sh',
  installMethod: 'shell-source', ...over
})
const manifestWith = (id: string, entries: unknown[]) => ({
  id, name: id, version: '1.0.0', redlogApi: 1, contributes: { capture: entries }
})
const HOOK = { 'hook.sh': '#!/bin/sh\n' }
const statusOf = (id: string) => loadPlugins().find((p) => p.manifest.id === id)!.status

beforeEach(() => {
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-trust-'))
  process.env.HOME = tmp
  process.env.USERPROFILE = tmp
})
afterEach(() => {
  for (const p of listPlugins()) unregisterCapturePlugins(p.manifest.id)
  process.env.HOME = realHome
  process.env.USERPROFILE = realUserProfile
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a capture that installs into the shell or Claude settings needs approval', () => {
  it.each(['shell-source', 'claude-settings'])('%s waits for consent; the tier stays declarative', (method) => {
    writePlugin('inst-plugin', manifestWith('inst-plugin', [capture({ installMethod: method })]), HOOK)
    const p = loadPlugins().find((x) => x.manifest.id === 'inst-plugin')!
    expect(p.tier).toBe('declarative')
    expect(requiresApproval(p.manifest)).toBe(true)
    expect(p.status).toBe('needs-consent')
  })

  it('a plugin whose captures are all manual is active without approval', () => {
    writePlugin('manual-plugin', manifestWith('manual-plugin', [capture({ installMethod: 'manual' })]), HOOK)
    expect(statusOf('manual-plugin')).toBe('active')
  })

  it('approval is pinned to the hook file: changing its bytes asks again', () => {
    const dir = writePlugin('pinned', manifestWith('pinned', [capture()]), HOOK)
    initPlugins()
    expect(grantPluginTrust('pinned').ok).toBe(true)
    expect(statusOf('pinned')).toBe('active')
    fs.writeFileSync(path.join(dir, 'hook.sh'), '#!/bin/sh\n# changed\n')
    expect(statusOf('pinned')).toBe('needs-consent')
  })

  it('until approved, only the manual entries are registered; approval releases the rest, revoke takes them back', () => {
    writePlugin('mixed', manifestWith('mixed', [
      capture({ id: 'auto' }),
      capture({ id: 'by-hand', installMethod: 'manual', manualSteps: [{ label: 'run', command: 'sh {hookFile}' }] })
    ]), HOOK)
    initPlugins()
    expect(getHookInstallPlan('mixed.auto')).toBeNull()
    expect(installHook('mixed.auto').message).toMatch(/Unknown plugin/)
    expect(getContributionReport('mixed')?.capture).toMatchObject({ accepted: 1, waiting: true })

    expect(grantPluginTrust('mixed').ok).toBe(true)
    expect(getHookInstallPlan('mixed.auto')).not.toBeNull()
    expect(getContributionReport('mixed')?.capture).toMatchObject({ accepted: 2 })
    expect(getContributionReport('mixed')?.capture?.waiting).toBeUndefined()

    revokePluginTrust('mixed')
    expect(getHookInstallPlan('mixed.auto')).toBeNull()
  })
})

describe('what a plugin capture may say about where it installs', () => {
  const problemOf = (over: Record<string, unknown>) =>
    validateManifest(manifestWith('probe-plugin', [capture(over)]), writePlugin('probe-plugin', {}, HOOK))

  it.each([
    ['powershell-profile'], ['bogus'], [undefined]
  ])('refuses installMethod %s', (method) => {
    const r = problemOf({ installMethod: method })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/installMethod/)
  })

  it.each([
    '../evil.sh', '..\\evil.sh', 'sub/x.sh', 'sub\\x.sh', '/etc/x.sh', 'C:\\x.sh', '~/.redlog/x.sh',
    'x.json', '.hidden.sh', 'x.sh/', ''
  ])('refuses installTarget %j', (target) => {
    const r = problemOf({ installTarget: target })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/installTarget/)
  })

  it.each(['dir/.zshrc', '../.zshrc', '.zshenv', '/etc/profile', '.gitconfig', '', '.zshrc/'])(
    'refuses shellRcFile %j', (rc) => {
      const r = problemOf({ shellRcFile: rc })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/shellRcFile/)
    })

  it('refuses a shell-source hook whose own file name would be written over something that is not a script', () => {
    const dir = writePlugin('probe-plugin', {}, { 'trust.json': '{}' })
    const r = validateManifest(manifestWith('probe-plugin', [capture({ hookFile: 'trust.json' })]), dir)
    expect(r.ok).toBe(false)
  })

  it.each(['.zshrc', '.bashrc', '.bash_profile', '.profile'])('accepts shellRcFile %s', (rc) => {
    expect(problemOf({ installTarget: 'acme-hook.sh', shellRcFile: rc }).ok).toBe(true)
  })

  it('a plugin with an unsafe install target is that plugin\'s error and nobody else\'s', () => {
    writePlugin('bad-target', manifestWith('bad-target', [capture({ installTarget: '../outside.sh' })]), HOOK)
    writePlugin('good-neighbour', manifestWith('good-neighbour', [capture({ installMethod: 'manual' })]), HOOK)
    const plugins = loadPlugins()
    const bad = plugins.find((p) => p.manifest.id === 'bad-target')!
    expect(bad.status).toBe('error')
    expect(bad.error).toMatch(/installTarget/)
    expect(plugins.find((p) => p.manifest.id === 'good-neighbour')!.status).toBe('active')
    expect(() => initPlugins()).not.toThrow()
  })

  it('registration refuses the same entries itself and does not throw', () => {
    const dir = writePlugin('direct', {}, HOOK)
    let r!: ReturnType<typeof registerCapturePlugins>
    expect(() => {
      r = registerCapturePlugins('direct', dir, [
        { id: 'a', name: 'a', description: '', agentType: 'shell', hookFile: 'hook.sh', installMethod: 'shell-source', installTarget: '../../x.sh' },
        { id: 'b', name: 'b', description: '', agentType: 'shell', hookFile: 'hook.sh', installMethod: 'shell-source', shellRcFile: 'dir/.zshrc' },
        { id: 'c', name: 'c', description: '', agentType: 'shell', hookFile: 'hook.sh', installMethod: 'powershell-profile' as never },
        { id: 'ok', name: 'ok', description: '', agentType: 'shell', hookFile: 'hook.sh', installMethod: 'shell-source', installTarget: 'direct-hook.sh', shellRcFile: '.zshrc' }
      ])
    }).not.toThrow()
    expect(r.accepted).toBe(1)
    expect(r.rejected.map((x) => x.name).sort()).toEqual(['a', 'b', 'c'])
    expect(getHookInstallPlan('direct.a')).toBeNull()
    // an accepted target lands directly inside ~/.redlog
    expect(getHookInstallPlan('direct.ok')?.[0].target).toBe(path.join(tmp, '.redlog', 'direct-hook.sh'))
  })
})

describe('plugin redaction can only add to what is masked', () => {
  afterEach(() => unregisterRedactionRules('red-plugin'))
  // Built from parts so this file carries no token-shaped literal.
  const SECRET = ['CORP', '_', 'ABCDEFGHIJ0123456789'].join('')

  it('a manifest with a redaction allowlist is refused by name', () => {
    const r = validateManifest({
      id: 'red-plugin', name: 'r', version: '1.0.0', redlogApi: 1,
      contributes: { redaction: { denylist: ['x'], allowlist: ['CORP_'] } }
    }, tmp)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/allowlist/)
  })

  it('a plugin that reaches the registrar with an allowlist cannot switch off the denylist or a loot value', () => {
    registerRedactionRules('red-plugin', { denylist: ['/CORP_[A-Z0-9]{20,}/'], allowlist: ['CORP_', 'tok-'] } as never)
    expect(redact(`export K=${SECRET}`).redacted.map((s) => s.pattern)).toEqual(['denylist'])
    // api-server merges the values loot detection found into the denylist per event
    const loot = 'tok-from-loot-0123456789'
    const withLoot = { ...getRules(), denylist: [...getRules().denylist, loot] }
    expect(redact(`x ${loot}`, withLoot).redacted.map((s) => s.pattern)).toEqual(['denylist'])
    expect(getRules().allowlist).toEqual([])
  })
})
