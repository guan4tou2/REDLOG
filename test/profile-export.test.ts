import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as yaml from 'js-yaml'
import { DEFAULT_CONFIG, type RedLogConfig } from '../src/core/config'
import { exportableProfile, writeProfileFile } from '../src/core/profile-export'
import { readProfileFile } from '../src/core/profile-file'
import { resolveProfile } from '../src/core/profile-import'

// "Export profile" wrote the whole project config into a file headed "share
// with your team": operator id and name, personal domains, local paths. It
// carries the engagement's scope, the target list and the exclusion list, and
// nothing else: the operator's own IP lists and the violation warning stay out,
// as they do from the event JSON export.

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
  it('holds exactly the two scope lists and the version', () => {
    expect(exportableProfile(config)).toEqual({
      version: 1,
      scope: { targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.5'] }
    })
  })

  it('round-trips through import unchanged, in both formats', () => {
    for (const name of ['p.yaml', 'p.json']) {
      const file = path.join(dir, name)
      const exported = exportableProfile(config)
      writeProfileFile(file, exported)
      const text = fs.readFileSync(file, 'utf-8')
      for (const leaked of ['op-secret', 'Real Name', 'me.example', '/Users/someone', '198.51.100.7', '203.0.113.9', 'whitelist', 'blacklist', 'warnOnViolation']) {
        expect(text).not.toContain(leaked)
      }
      const parsed = name.endsWith('.json') ? JSON.parse(text) : yaml.load(text)
      expect(Object.keys(parsed as object).sort()).toEqual(['scope', 'version'])
      const r = resolveProfile(parsed)
      expect(r.ok && r.profile).toEqual({ scope: { targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.5'] } })
      // Through the file reader too: what is written is what is read back.
      expect(readProfileFile(file)).toEqual({ status: 'imported', profile: { scope: exported.scope } })
    }
  })

  it('an engagement with no scope exports two empty lists, which import reads back as an import', () => {
    const file = path.join(dir, 'empty-scope.json')
    writeProfileFile(file, exportableProfile(DEFAULT_CONFIG))
    expect(readProfileFile(file)).toMatchObject({ status: 'imported', profile: { scope: { targets: [], excludeTargets: [] } } })
  })

  it.skipIf(process.platform === 'win32')('is owner-only, including over an existing file', () => {
    const file = path.join(dir, 'existing.yaml')
    fs.writeFileSync(file, 'old', { mode: 0o644 })
    writeProfileFile(file, exportableProfile(config))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
