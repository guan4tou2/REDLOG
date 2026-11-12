import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { DEFAULT_CONFIG, type RedLogConfig } from '../src/core/config'
import { exportableProfile, writeProfileFile } from '../src/core/profile-export'
import { resolveProfile } from '../src/core/profile-import'

// "Export profile" wrote the whole project config into a file headed "share
// with your team": operator id and name, personal domains, local paths. It
// carries what import applies, and nothing else.

const config: RedLogConfig = {
  ...DEFAULT_CONFIG,
  operator: { id: 'op-secret', name: 'Real Name' },
  scope: {
    ...DEFAULT_CONFIG.scope,
    targets: ['10.0.0.0/24'],
    excludeTargets: ['10.0.0.5'],
    warnOnViolation: false,
    personalDomains: ['me.example'],
    scopeFile: '/Users/someone/scope.txt'
  },
  network: { ...DEFAULT_CONFIG.network, whitelist: ['198.51.100.7'], blacklist: ['203.0.113.9'] }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-profile-export-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('profile export', () => {
  it('holds exactly the five importable settings and the version', () => {
    expect(exportableProfile(config)).toEqual({
      version: 1,
      scope: { targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.5'], warnOnViolation: false },
      network: { whitelist: ['198.51.100.7'], blacklist: ['203.0.113.9'] }
    })
  })

  it('round-trips through import unchanged, in both formats', () => {
    for (const name of ['p.yaml', 'p.json']) {
      const file = path.join(dir, name)
      writeProfileFile(file, exportableProfile(config))
      const text = fs.readFileSync(file, 'utf-8')
      expect(text).not.toContain('op-secret')
      expect(text).not.toContain('Real Name')
      expect(text).not.toContain('me.example')
      expect(text).not.toContain('/Users/someone')
      const parsed = name.endsWith('.json') ? JSON.parse(text) : yaml.load(text)
      expect(Object.keys(parsed as object).sort()).toEqual(['network', 'scope', 'version'])
      const r = resolveProfile(parsed)
      expect(r.ok && r.profile).toEqual({
        scope: { targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.5'], warnOnViolation: false },
        network: { whitelist: ['198.51.100.7'], blacklist: ['203.0.113.9'] }
      })
    }
  })

  it.skipIf(process.platform === 'win32')('is owner-only, including over an existing file', () => {
    const file = path.join(dir, 'existing.yaml')
    fs.writeFileSync(file, 'old', { mode: 0o644 })
    writeProfileFile(file, exportableProfile(config))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
