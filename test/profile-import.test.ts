// #297: what importing a profile resolves to, and why a file is refused.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/core/config'
import { readProfileFile } from '../src/core/profile-file'
import { profileSummary, profileToInitialConfig, resolveProfile } from '../src/core/profile-import'

function ok(data: unknown) {
  const r = resolveProfile(data)
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.failure)}`)
  return r.profile
}

describe('resolveProfile', () => {
  const fail = (data: unknown) => {
    const r = resolveProfile(data)
    return r.ok ? null : r.failure
  }

  it('lays only what the file says over the defaults', () => {
    const p = ok({ version: 1, scope: { targets: ['198.51.100.0/24'] } })
    expect(p).toEqual({ scope: { targets: ['198.51.100.0/24'], excludeTargets: [] } })
  })

  it('keeps its defaults in step with the real ones', () => {
    const p = ok({ version: 1, scope: { targets: [] } })
    expect(p.scope.targets).toEqual(DEFAULT_CONFIG.scope.targets)
    expect(p.scope.excludeTargets).toEqual(DEFAULT_CONFIG.scope.excludeTargets)
    const cfg = profileToInitialConfig(p)
    expect(cfg.scope.scopeFile).toBe(DEFAULT_CONFIG.scope.scopeFile)
    // Only scope crosses: the operator's IP lists and the warning stay at the defaults.
    expect(Object.keys(cfg)).toEqual(['scope'])
    expect(Object.keys(cfg.scope).sort()).toEqual(['excludeTargets', 'personalDomains', 'scopeFile', 'targets'])
  })

  it('keeps an explicit empty list', () => {
    const p = ok({ version: 1, scope: { targets: [] } })
    expect(p.scope.targets).toEqual([])
  })

  it('takes a profile that carries only exclusions', () => {
    expect(ok({ version: 1, scope: { excludeTargets: ['192.0.2.9'] } }).scope.excludeTargets).toEqual(['192.0.2.9'])
  })

  it('does not alias the input', () => {
    const input = { version: 1, scope: { targets: ['a'] } }
    const p = ok(input)
    p.scope.targets.push('b')
    expect(input.scope.targets).toEqual(['a'])
  })

  it('requires version 1, exactly', () => {
    expect(fail({ scope: { targets: ['a'] } })).toEqual({ code: 'version', found: null })
    expect(fail({ version: 2, scope: { targets: ['a'] } })).toEqual({ code: 'version', found: '2' })
    expect(fail({ version: '1', scope: { targets: ['a'] } })).toEqual({ code: 'version', found: '"1"' })
    expect(fail({ version: 1.5, scope: { targets: ['a'] } })).toEqual({ code: 'version', found: '1.5' })
  })

  it('refuses unknown fields and lists every one, instead of ignoring them', () => {
    expect(fail({ version: 1, scope: { targets: ['a'] }, operator: { id: 'x' }, views: [] }))
      .toEqual({ code: 'unknown', fields: ['operator', 'views'] })
    expect(fail({ version: 1, scope: { targets: ['a'], warnOnViolation: false, personalDomains: [] } }))
      .toEqual({ code: 'unknown', fields: ['scope.warnOnViolation', 'scope.personalDomains'] })
    expect(fail({ version: 1, scope: { targets: ['a'], warnOnViolation: false }, network: { whitelist: [] } }))
      .toEqual({ code: 'unknown', fields: ['network', 'scope.warnOnViolation'] })
  })

  it('refuses the old five-setting file instead of applying part of it', () => {
    const old = { version: 1, scope: { targets: ['a'], excludeTargets: [], warnOnViolation: true }, network: { whitelist: ['1.1.1.1'], blacklist: [] } }
    expect(fail(old)).toEqual({ code: 'unknown', fields: ['network', 'scope.warnOnViolation'] })
  })

  it('checks the version before anything else in the file', () => {
    expect(fail({ network: {}, scope: 'x' })).toEqual({ code: 'version', found: null })
  })

  it('names the field that is the wrong kind', () => {
    expect(fail({ version: 1, scope: { targets: 'a' } })).toEqual({ code: 'shape', field: 'scope.targets', expected: 'list' })
    expect(fail({ version: 1, scope: { excludeTargets: { a: 1 } } })).toEqual({ code: 'shape', field: 'scope.excludeTargets', expected: 'list' })
    expect(fail({ version: 1, scope: { targets: ['a', 7] } })).toEqual({ code: 'shape', field: 'scope.targets[1]', expected: 'list' })
    expect(fail({ version: 1, scope: 'x' })).toEqual({ code: 'shape', field: 'scope', expected: 'object' })
    expect(fail([])).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
    expect(fail('scope')).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
    expect(fail(undefined)).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
  })

  it('refuses a file with neither list', () => {
    expect(resolveProfile({ version: 1 })).toEqual({ ok: false, failure: { code: 'empty' } })
    expect(resolveProfile({ version: 1, scope: {} })).toEqual({ ok: false, failure: { code: 'empty' } })
  })

  it('does not mistake a section that has a `code` key for a failure', () => {
    expect(fail({ version: 1, scope: { code: 'x', targets: ['a'] } })).toEqual({ code: 'unknown', fields: ['scope.code'] })
  })
})

describe('profileSummary', () => {
  it('names the two lists that are not empty', () => {
    const p = ok({ version: 1, scope: { targets: ['a', 'b'], excludeTargets: ['c'] } })
    expect(profileSummary(p)).toEqual([
      { key: 'project.appliedScope', count: 2 },
      { key: 'project.appliedExcluded', count: 1 }
    ])
  })

  it('is empty for a profile that only restates the defaults', () => {
    expect(profileSummary(ok({ version: 1, scope: { targets: [] } }))).toEqual([])
  })
})

describe('readProfileFile', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-profile-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const write = (name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f }

  it('reads json and yaml', () => {
    const j = readProfileFile(write('a.json', '{"version":1,"scope":{"excludeTargets":["192.0.2.9"]}}'))
    expect(j).toMatchObject({ status: 'imported', profile: { scope: { excludeTargets: ['192.0.2.9'] } } })
    const y = readProfileFile(write('b.yaml', 'version: 1\nscope:\n  targets:\n    - 192.0.2.0/24\n'))
    expect(y).toMatchObject({ status: 'imported', profile: { scope: { targets: ['192.0.2.0/24'] } } })
  })

  it('says the shape is wrong, not that it failed to parse, for an empty yaml file', () => {
    for (const text of ['', '# only a comment\n']) {
      expect(readProfileFile(write('empty.yaml', text))).toMatchObject({ status: 'failed', failure: { code: 'shape', field: '(file)' } })
    }
  })

  it('says read when the file is not there', () => {
    const r = readProfileFile(path.join(dir, 'missing.json'))
    expect(r).toMatchObject({ status: 'failed', failure: { code: 'read' } })
  })

  it('says parse for malformed json and yaml', () => {
    expect(readProfileFile(write('bad.json', '{"scope":'))).toMatchObject({ status: 'failed', failure: { code: 'parse' } })
    expect(readProfileFile(write('bad.yaml', 'scope: [unclosed\n'))).toMatchObject({ status: 'failed', failure: { code: 'parse' } })
  })

  it('says shape or empty for a file that parses to the wrong thing', () => {
    expect(readProfileFile(write('arr.json', '[1,2]'))).toMatchObject({ status: 'failed', failure: { code: 'shape', field: '(file)' } })
    expect(readProfileFile(write('empty.yaml', ''))).toMatchObject({ status: 'failed', failure: { code: 'shape', field: '(file)' } })
    expect(readProfileFile(write('t.json', '{"version":1,"scope":{"targets":"x"}}'))).toMatchObject({ status: 'failed', failure: { code: 'shape', field: 'scope.targets' } })
    expect(readProfileFile(write('none.json', '{"version":1}'))).toMatchObject({ status: 'failed', failure: { code: 'empty' } })
    expect(readProfileFile(write('v.json', '{"scope":{"targets":["a"]}}'))).toMatchObject({ status: 'failed', failure: { code: 'version', found: null } })
    expect(readProfileFile(write('net.yaml', 'version: 1\nscope:\n  targets: [a]\nnetwork:\n  blacklist: [1.1.1.1]\n'))).toMatchObject({ status: 'failed', failure: { code: 'unknown', fields: ['network'] } })
  })
})
