import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig, saveConfig, loadScopeFile } from '../src/core/config'

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
    expect(config.scope.alertFloor).toBe('adjacent')
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

  it('migrates scope.enforcement: warn → alertFloor: adjacent', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'scope:\n  enforcement: warn\n')
    const config = loadConfig(tmpDir)
    expect(config.scope.alertFloor).toBe('adjacent')
    expect((config.scope as unknown as { enforcement?: string }).enforcement).toBeUndefined()
  })

  it('migrates scope.enforcement: log → alertFloor: excluded_only', () => {
    // Old 'log' mode did nothing; the direct semantic equivalent is warnings off.
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'scope:\n  enforcement: log\n')
    const config = loadConfig(tmpDir)
    expect(config.scope.alertFloor).toBe('excluded_only')
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
