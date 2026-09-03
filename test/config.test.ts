import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  })

  it('merges partial config with defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'engagement:\n  id: test-123\n')
    const config = loadConfig(tmpDir)
    expect(config.engagement.id).toBe('test-123')
    expect(config.engagement.name).toBe('Default Engagement')
    expect(config.network.checkInterval).toBe(60)
  })

  it('migrates vpnIPs → whitelist', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'network:\n  vpnIPs:\n    - 10.8.0.0/24\n')
    const config = loadConfig(tmpDir)
    expect(config.network.whitelist).toEqual(['10.8.0.0/24'])
  })

  it('migrates dailyIPs → blacklist', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'network:\n  dailyIPs:\n    - 114.24.0.0/16\n')
    const config = loadConfig(tmpDir)
    expect(config.network.blacklist).toEqual(['114.24.0.0/16'])
  })

  it('does not overwrite new names with old during migration', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'),
      'network:\n  safeIPs:\n    - 10.0.0.0/8\n  vpnIPs:\n    - 172.16.0.0/12\n')
    const config = loadConfig(tmpDir)
    expect(config.network.whitelist).toEqual(['10.0.0.0/8'])
  })

  it('migrates scope.enforcement: warn → warnOnViolation: true', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'scope:\n  enforcement: warn\n')
    const config = loadConfig(tmpDir)
    expect(config.scope.warnOnViolation).toBe(true)
    expect((config.scope as unknown as { enforcement?: string }).enforcement).toBeUndefined()
  })

  it('migrates scope.enforcement: log → warnOnViolation: false', () => {
    // Old 'log' mode did nothing; the direct semantic equivalent is warnings off.
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'scope:\n  enforcement: log\n')
    const config = loadConfig(tmpDir)
    expect(config.scope.warnOnViolation).toBe(false)
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
