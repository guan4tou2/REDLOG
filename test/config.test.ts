import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig, saveConfig, loadScopeFile, snapshotScope, type RedLogConfig } from '../src/core/config'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadConfig(tmpDir)
    expect(config.engagement.id).toBe('default')
    expect(config.network.whitelist).toEqual([])
    expect(config.network.blacklist).toEqual([])
    expect(config.network.checkInterval).toBe(60)
    expect(config.scope.warnOnViolation).toBe(true)
    expect(config.packs?.aiAgents).toBe(false)
  })

  it('merges partial config with defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'engagement:\n  id: test-123\n')
    const config = loadConfig(tmpDir)
    expect(config.engagement.id).toBe('test-123')
    expect(config.network.checkInterval).toBe(60)
    expect(config.packs?.aiAgents).toBe(false)
  })

})

describe('saveConfig', () => {
  it('writes yaml that loadConfig can read back', () => {
    const config = loadConfig(tmpDir)
    config.engagement.id = 'roundtrip-test'
    config.network.whitelist = ['10.8.0.1']
    saveConfig(tmpDir, config)
    const reloaded = loadConfig(tmpDir)
    expect(reloaded.engagement.id).toBe('roundtrip-test')
    expect(reloaded.network.whitelist).toEqual(['10.8.0.1'])
  })
})

// A loaded config is the caller's to change, and callers do: targetContext:set
// assigns `engagement.activeTarget` and saves. loadConfig handed out the
// defaults' own objects, all of them when there was no config.yaml (a shallow
// `{ ...DEFAULT_CONFIG }`) and any section or array a file left unset, so one
// such write changed the defaults for every later load in the process: a new
// project inherited the last one's current target, and a whitelist entry
// crossed projects.
describe('loadConfig hands each caller its own defaults', () => {
  // A fresh module per case, so what fails is the case's own change, not one
  // an earlier test in this file made to the shared defaults.
  const freshLoad = async (): Promise<typeof loadConfig> => {
    vi.resetModules()
    return (await import('../src/core/config')).loadConfig
  }
  const dirs: string[] = []
  const newDir = (yaml?: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-defaults-'))
    dirs.push(dir)
    if (yaml) fs.writeFileSync(path.join(dir, 'config.yaml'), yaml)
    return dir
  }
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

  // The documented defaults (docs/TESTING.md Part 2) for what the cases touch.
  const expectDefaults = (config: RedLogConfig): void => {
    expect(config.engagement.id).toBe('default')
    expect(config.engagement.activeTarget).toBeNull()
    expect(config.network.whitelist).toEqual([])
    expect(config.scope.targets).toEqual([])
  }

  it('a change to a config loaded with no file reaches no later load', async () => {
    const load = await freshLoad()
    const first = load(newDir())
    first.network.whitelist.push('198.51.100.7')
    first.scope.targets.push('10.10.11.0/24')
    first.engagement.activeTarget = '10.10.11.24'
    first.engagement.id = 'project-a'
    expectDefaults(load(newDir()))
    const partial = load(newDir('operator:\n  id: op-b\n'))
    expect(partial.operator.id).toBe('op-b')
    expectDefaults(partial)
  })

  it('a change to a section the file left unset reaches no later load', async () => {
    const load = await freshLoad()
    const first = load(newDir('operator:\n  id: op-a\n'))
    first.network.whitelist.push('198.51.100.7')
    first.engagement.activeTarget = '10.10.11.24'
    expectDefaults(load(newDir()))
    expectDefaults(load(newDir('operator:\n  id: op-b\n')))
  })
})

describe('agent transcript capture default', () => {
  // Spec 035: agent transcripts run with the AI agents pack. A partial or
  // hand-written config must never turn it on — including one that still
  // carries the removed `agentTailer.enabled: true`.
  it('stays off unless the pack is explicitly on', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'agentTailer:\n  enabled: true\n')
    expect(loadConfig(tmpDir).packs?.aiAgents).toBe(false)
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'packs:\n  aiAgents: true\n')
    expect(loadConfig(tmpDir).packs?.aiAgents).toBe(true)
  })
})

describe('loadScopeFile', () => {
  it('loads plain text file with one target per line', () => {
    const scopePath = path.join(tmpDir, 'scope.txt')
    fs.writeFileSync(scopePath, '# comment\n192.168.1.0/24\n*.example.com\n\n')
    const targets = loadScopeFile(scopePath)
    expect(targets).toEqual(['192.168.1.0/24', '*.example.com'])
  })

  it('loads JSON array', () => {
    const scopePath = path.join(tmpDir, 'scope.json')
    fs.writeFileSync(scopePath, JSON.stringify(['10.0.0.1', 'target.com']))
    const targets = loadScopeFile(scopePath)
    expect(targets).toEqual(['10.0.0.1', 'target.com'])
  })

  it('returns empty array for nonexistent file', () => {
    expect(loadScopeFile('/nonexistent/scope.txt')).toEqual([])
  })
})

describe('snapshotScope — the scope actually in force', () => {
  // `config.scope.targets` is not the boundary the policy sees: a project can
  // point at a Burp or ZAP scope file, and what is enforced is the
  // concatenation. That merge used to be written out by hand at three call
  // sites, which is three chances for "the scope" to mean three things.
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const cfg = (scope: Record<string, unknown>): RedLogConfig =>
    ({ scope } as unknown as RedLogConfig)

  it('merges the scope file into the targets, deduped and in order', () => {
    const file = path.join(dir, 'scope.txt')
    fs.writeFileSync(file, 'b.example\n# a comment\na.example\nb.example\n')
    const s = snapshotScope(cfg({ targets: ['a.example'], excludeTargets: ['x.example'], scopeFile: file }))
    expect(s.targets).toEqual(['a.example', 'b.example'])
    expect(s.excludeTargets).toEqual(['x.example'])
    // The count is what the FILE listed, before deduping against the config
    // list — it describes the file, not the merge.
    expect(s.scopeFileEntries).toBe(3)
  })

  it('hashes the file contents, so editing it on disk moves the boundary', () => {
    // The path alone cannot say the scope changed — an operator editing the
    // file changes what is enforced without touching config.yaml.
    const file = path.join(dir, 'scope.txt')
    fs.writeFileSync(file, 'a.example\n')
    const before = snapshotScope(cfg({ targets: [], scopeFile: file })).scopeFileSha256
    fs.writeFileSync(file, 'a.example\nb.example\n')
    const after = snapshotScope(cfg({ targets: [], scopeFile: file })).scopeFileSha256
    expect(before).toBeTruthy()
    expect(after).not.toBe(before)
  })

  it('treats a missing or unreadable file as contributing nothing', () => {
    const s = snapshotScope(cfg({ targets: ['a.example'], scopeFile: path.join(dir, 'nope.txt') }))
    expect(s.targets).toEqual(['a.example'])
    expect(s.scopeFileSha256).toBeNull()
    expect(s.scopeFileEntries).toBe(0)
  })

  it('handles a project with no scope block at all', () => {
    expect(snapshotScope({} as RedLogConfig)).toMatchObject({
      targets: [], excludeTargets: [], scopeFile: null, scopeFileSha256: null
    })
  })
})
