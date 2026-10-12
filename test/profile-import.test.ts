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
  it('lays only what the file says over the defaults', () => {
    const p = ok({ scope: { targets: ['198.51.100.0/24'] } })
    expect(p.scope.targets).toEqual(['198.51.100.0/24'])
    expect(p.scope.excludeTargets).toEqual([])
    expect(p.scope.warnOnViolation).toBe(true)
    expect(p.network).toEqual({ whitelist: [], blacklist: [] })
  })

  it('keeps its defaults in step with the real ones', () => {
    const p = ok({ scope: { warnOnViolation: true } })
    expect(p.scope.warnOnViolation).toBe(DEFAULT_CONFIG.scope.warnOnViolation)
    expect(p.scope.targets).toEqual(DEFAULT_CONFIG.scope.targets)
    expect(p.scope.excludeTargets).toEqual(DEFAULT_CONFIG.scope.excludeTargets)
    expect(p.network.whitelist).toEqual(DEFAULT_CONFIG.network.whitelist)
    expect(p.network.blacklist).toEqual(DEFAULT_CONFIG.network.blacklist)
    expect(profileToInitialConfig(p).network.checkInterval).toBe(DEFAULT_CONFIG.network.checkInterval)
    expect(profileToInitialConfig(p).scope.scopeFile).toBe(DEFAULT_CONFIG.scope.scopeFile)
  })

  it('keeps false, and an explicit empty list', () => {
    const p = ok({ scope: { warnOnViolation: false, targets: [] } })
    expect(p.scope.warnOnViolation).toBe(false)
    expect(p.scope.targets).toEqual([])
    expect(profileToInitialConfig(p).scope.warnOnViolation).toBe(false)
  })

  it('takes a profile that carries only exclusions', () => {
    expect(ok({ scope: { excludeTargets: ['192.0.2.9'] } }).scope.excludeTargets).toEqual(['192.0.2.9'])
  })

  it('ignores the rest of an exported config', () => {
    const p = ok({ version: 1, operator: { id: 'x' }, screenshot: { quality: 5 }, views: [], scope: { targets: ['a'] } })
    expect(p.scope.targets).toEqual(['a'])
  })

  it('does not alias the input', () => {
    const input = { scope: { targets: ['a'] } }
    const p = ok(input)
    p.scope.targets.push('b')
    expect(input.scope.targets).toEqual(['a'])
  })

  it('names the field that is the wrong kind', () => {
    const shape = (data: unknown) => {
      const r = resolveProfile(data)
      return r.ok ? null : r.failure
    }
    expect(shape({ scope: { targets: 'a' } })).toEqual({ code: 'shape', field: 'scope.targets', expected: 'list' })
    expect(shape({ scope: { excludeTargets: { a: 1 } } })).toEqual({ code: 'shape', field: 'scope.excludeTargets', expected: 'list' })
    expect(shape({ scope: { targets: ['a', 7] } })).toEqual({ code: 'shape', field: 'scope.targets[1]', expected: 'list' })
    expect(shape({ scope: { warnOnViolation: 'false' } })).toEqual({ code: 'shape', field: 'scope.warnOnViolation', expected: 'boolean' })
    expect(shape({ network: { whitelist: 1 } })).toEqual({ code: 'shape', field: 'network.whitelist', expected: 'list' })
    expect(shape({ network: { blacklist: [null] } })).toEqual({ code: 'shape', field: 'network.blacklist[0]', expected: 'list' })
    expect(shape({ scope: 'x' })).toEqual({ code: 'shape', field: 'scope', expected: 'object' })
    expect(shape({ network: [] })).toEqual({ code: 'shape', field: 'network', expected: 'object' })
    expect(shape([])).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
    expect(shape('scope')).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
    expect(shape(undefined)).toEqual({ code: 'shape', field: '(file)', expected: 'object' })
  })

  it('refuses a file with none of the five settings', () => {
    const r = resolveProfile({ version: 1, operator: { id: 'x' } })
    expect(r).toEqual({ ok: false, failure: { code: 'empty' } })
  })

  it('does not mistake a section that has a `code` key for a failure', () => {
    expect(ok({ scope: { code: 'x', targets: ['a'] } }).scope.targets).toEqual(['a'])
  })
})

describe('profileSummary', () => {
  it('names every setting that differs from the defaults, warning included', () => {
    const p = ok({ scope: { targets: ['a', 'b'], excludeTargets: ['c'], warnOnViolation: false }, network: { whitelist: ['1'], blacklist: ['2', '3'] } })
    expect(profileSummary(p)).toEqual([
      { key: 'project.appliedScope', count: 2 },
      { key: 'project.appliedExcluded', count: 1 },
      { key: 'project.appliedSafe', count: 1 },
      { key: 'project.appliedExposed', count: 2 },
      { key: 'project.appliedNoWarn' }
    ])
  })

  it('is empty for a profile that only restates the defaults', () => {
    expect(profileSummary(ok({ scope: { targets: [], warnOnViolation: true } }))).toEqual([])
  })
})

describe('readProfileFile', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-profile-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const write = (name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f }

  it('reads json and yaml', () => {
    const j = readProfileFile(write('a.json', '{"scope":{"warnOnViolation":false}}'))
    expect(j).toMatchObject({ status: 'imported', profile: { scope: { warnOnViolation: false } } })
    const y = readProfileFile(write('b.yaml', 'scope:\n  targets:\n    - 192.0.2.0/24\n'))
    expect(y).toMatchObject({ status: 'imported', profile: { scope: { targets: ['192.0.2.0/24'] } } })
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
    expect(readProfileFile(write('t.json', '{"scope":{"targets":"x"}}'))).toMatchObject({ status: 'failed', failure: { code: 'shape', field: 'scope.targets' } })
    expect(readProfileFile(write('none.json', '{"version":1}'))).toMatchObject({ status: 'failed', failure: { code: 'empty' } })
  })
})
