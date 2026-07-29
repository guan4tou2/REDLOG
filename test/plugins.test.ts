import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// These tests write and load real plugin files from a temp home dir. On Windows
// CI (Defender scanning every written file) that occasionally exceeds the 5s
// default; give the whole suite generous headroom so a slow disk isn't a flake.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

import { validateManifest, computeContentHash, tierOf } from '../src/core/plugins/manifest'
import { loadPlugins } from '../src/core/plugins/loader'
import { grant, isTrusted, revoke } from '../src/core/plugins/trust'
import { applyContributions, removeContributions } from '../src/core/plugins/contributions'
import { extractTarget, unregisterTargetExtractors } from '../src/core/target-extractor'
import { getRules, unregisterRedactionRules } from '../src/core/redaction'
import { detectHooks, unregisterCapturePlugins } from '../src/core/hooks-manager'
import {
  registerPluginTools, unregisterPluginTools, listPluginTools, dispatchPluginTool,
  toolName, methodAllowed
} from '../src/core/plugins/tool-registry'

// Isolate all plugin stores (trust/state) + userRoot under a temp home dir.
// os.homedir() reads HOME on POSIX but USERPROFILE on Windows — set both.
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

beforeEach(() => {
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plug-'))
  process.env.HOME = tmp
  process.env.USERPROFILE = tmp
})
afterEach(() => {
  process.env.HOME = realHome
  process.env.USERPROFILE = realUserProfile
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('manifest validation', () => {
  it('rejects bad id, path traversal, unknown capability', () => {
    const dir = tmp
    expect(validateManifest({ id: 'Bad Id', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} }, dir).ok).toBe(false)
    expect(validateManifest({ id: 'ok', name: 'x', version: 'nope', redlogApi: 1, contributes: {} }, dir).ok).toBe(false)
    expect(validateManifest(
      { id: 'ok', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {}, capabilities: ['do:anything'] }, dir
    ).ok).toBe(false)
    expect(validateManifest(
      { id: 'ok', name: 'x', version: '1.0.0', redlogApi: 1, contributes: { mcpTools: '../../etc/passwd' } }, dir
    ).ok).toBe(false)
  })

  it('classifies tier by whether it contributes code', () => {
    const declarative = validateManifest(
      { id: 'pack-a', name: 'A', version: '1.0.0', redlogApi: 1, contributes: { lootPatterns: [] } }, tmp
    )
    expect(declarative.ok).toBe(true)
    expect(tierOf(declarative.manifest!)).toBe('declarative')
  })
})

describe('loader + declarative contributions', () => {
  it('loads a declarative plugin as active and wires its patterns', () => {
    writePlugin('recon-pack', {
      id: 'recon-pack', name: 'Recon Pack', version: '1.0.0', redlogApi: 1,
      contributes: {
        lootPatterns: [{ type: 'acme_token', pattern: 'ACME-[0-9]{8}', confidence: 'high' }],
        redaction: { denylist: ['/S*SECRET*/'] },
        targetExtractors: [{ cmd: '^myscan\\s', extract: '--host\\s+(\\S+)' }]
      }
    })
    const plugins = loadPlugins()
    const p = plugins.find((x) => x.manifest.id === 'recon-pack')!
    expect(p.status).toBe('active')
    expect(p.tier).toBe('declarative')

    applyContributions(p)
    // target extractor now knows the bespoke tool
    expect(extractTarget('myscan --host 10.0.0.9')).toBe('10.0.0.9')
    // redaction denylist merged
    expect(getRules().denylist).toContain('/S*SECRET*/')

    removeContributions('recon-pack')
    unregisterTargetExtractors('recon-pack')
    unregisterRedactionRules('recon-pack')
  })

  it('exposes a capture contribution through the hooks manager', () => {
    writePlugin('cap-plugin', {
      id: 'cap-plugin', name: 'Cap', version: '1.0.0', redlogApi: 1,
      contributes: {
        capture: [{
          id: 'thing', name: 'Thing Capture', description: 'd', agentType: 'shell',
          hookFile: 'hook.sh', installMethod: 'manual',
          manualSteps: [{ label: 'run it', command: 'bash {hookFile}' }]
        }]
      }
    }, { 'hook.sh': '#!/bin/bash\n' })
    const p = loadPlugins().find((x) => x.manifest.id === 'cap-plugin')!
    applyContributions(p)
    const hook = detectHooks().find((h) => h.id === 'cap-plugin.thing')
    expect(hook).toBeTruthy()
    // {hookFile} placeholder resolved to the absolute path
    expect(hook!.manualSteps?.[0].command).toContain(path.join(p.dir, 'hook.sh'))
    unregisterCapturePlugins('cap-plugin')
  })
})

describe('privileged trust gate', () => {
  const priv = {
    id: 'tool-plugin', name: 'Tool', version: '1.0.0', redlogApi: 1,
    capabilities: ['read:events'],
    contributes: { mcpTools: 'code/tools.js' }
  }

  it('is needs-consent until granted, and grant pins the content hash', () => {
    const dir = writePlugin('tool-plugin', priv, { 'code/tools.js': 'exports.tools = []\n' })
    let p = loadPlugins().find((x) => x.manifest.id === 'tool-plugin')!
    expect(p.tier).toBe('privileged')
    expect(p.status).toBe('needs-consent')

    grant('tool-plugin', p.contentHash, ['read:events'])
    p = loadPlugins().find((x) => x.manifest.id === 'tool-plugin')!
    expect(p.status).toBe('active')

    // changing the code invalidates the pinned trust → back to needs-consent
    fs.writeFileSync(path.join(dir, 'code', 'tools.js'), 'exports.tools = [1]\n')
    p = loadPlugins().find((x) => x.manifest.id === 'tool-plugin')!
    expect(p.status).toBe('needs-consent')
    expect(isTrusted('tool-plugin', p.contentHash, ['read:events'])).toBe(false)
    revoke('tool-plugin')
  })

  it('capability gate maps ctx methods to caps and denies unknowns', () => {
    expect(methodAllowed('events.query', ['read:events'])).toBe(true)
    expect(methodAllowed('events.append', ['read:events'])).toBe(false)
    expect(methodAllowed('events.append', ['write:events'])).toBe(true)
    expect(methodAllowed('fs.readFile', ['read:events', 'write:events'])).toBe(false) // not a known method
  })

  it('does not grant capabilities beyond what was consented', () => {
    const dir = writePlugin('tool2', { ...priv, id: 'tool2', capabilities: ['read:events'] },
      { 'code/tools.js': 'exports.tools = []\n' })
    const hash = computeContentHash(
      validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8')), dir).manifest!, dir
    )
    grant('tool2', hash, ['read:events'])
    // manifest later asks for more than granted
    expect(isTrusted('tool2', hash, ['read:events', 'write:events'])).toBe(false)
    revoke('tool2')
  })
})

describe('shipped example plugins', () => {
  const examplesDir = path.join(__dirname, '..', 'examples', 'plugins')
  for (const id of ['recon-pack', 'geoip-tool']) {
    it(`example ${id} has a valid manifest`, () => {
      const dir = path.join(examplesDir, id)
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'))
      const parsed = validateManifest(raw, dir)
      expect(parsed.ok, parsed.error).toBe(true)
    })
  }
})

describe('plugin MCP tool registry', () => {
  afterEach(() => { unregisterPluginTools('geo'); unregisterPluginTools('other') })

  it('namespaces tool names to the plugin id', () => {
    expect(toolName('geo', 'lookup')).toBe('geo_lookup')
    expect(toolName('geo', 'geo_lookup')).toBe('geo_lookup') // already prefixed
    expect(toolName('my-plug', 'do')).toBe('my_plug_do')     // hyphen → underscore
  })

  it('routes a call to the owning plugin and returns its result', async () => {
    registerPluginTools('geo', [{ name: 'lookup', description: 'd', inputSchema: {} }],
      async (name, args) => ({ echoed: name, ip: args.ip }))
    const names = listPluginTools().map((t) => t.name)
    expect(names).toContain('geo_lookup')

    const hit = await dispatchPluginTool('geo_lookup', { ip: '1.1.1.1' })
    expect(hit.owned).toBe(true)
    expect((hit.result as { ip: string }).ip).toBe('1.1.1.1')

    const miss = await dispatchPluginTool('nonexistent_tool', {})
    expect(miss.owned).toBe(false)
  })
})
