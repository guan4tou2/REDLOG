// Spec 068 FR-010/FR-011: what the project picker may say about a project's
// scope without opening it. The one rule that matters: a scope that could not
// be READ is `unknown`, never `unset`. loadConfig swallows every error and
// returns defaults, so it cannot be used here — it would turn a corrupt
// config.yaml into "no scope set".

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProjectScope } from '../src/core/config'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-summary-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const writeConfig = (text: string) => fs.writeFileSync(path.join(dir, 'config.yaml'), text)
const writeScopeFile = (name: string, text: string) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, text)
  return p
}

describe('readProjectScope — configured targets', () => {
  it('a project with no config.yaml has no scope set', () => {
    expect(readProjectScope(dir)).toEqual({ state: 'unset' })
  })

  it('an empty config.yaml has no scope set', () => {
    writeConfig('')
    expect(readProjectScope(dir)).toEqual({ state: 'unset' })
  })

  it('a config with an empty target list has no scope set', () => {
    writeConfig('scope:\n  targets: []\n')
    expect(readProjectScope(dir)).toEqual({ state: 'unset' })
  })

  it('counts the declared targets', () => {
    writeConfig('scope:\n  targets:\n    - 10.0.0.0/24\n    - app.example.com\n')
    expect(readProjectScope(dir)).toEqual({ state: 'set', count: 2 })
  })

  it('does not count personal domains or exclusions as scope', () => {
    writeConfig('scope:\n  excludeTargets: [admin.example.com]\n  personalDomains: [localhost]\n')
    expect(readProjectScope(dir)).toEqual({ state: 'unset' })
  })
})

describe('readProjectScope — scope file', () => {
  it('counts entries declared only in the scope file', () => {
    const file = writeScopeFile('scope.txt', '# header\n10.0.0.1\n10.0.0.2\n\n')
    writeConfig(`scope:\n  scopeFile: ${JSON.stringify(file)}\n`)
    expect(readProjectScope(dir)).toEqual({ state: 'set', count: 2 })
  })

  it('counts an entry present in both places once', () => {
    const file = writeScopeFile('scope.txt', '10.0.0.1\n10.0.0.2\n')
    writeConfig(`scope:\n  targets: [10.0.0.1, app.example.com]\n  scopeFile: ${JSON.stringify(file)}\n`)
    expect(readProjectScope(dir)).toEqual({ state: 'set', count: 3 })
  })

  it('an empty scope file with no targets is unset', () => {
    const file = writeScopeFile('scope.txt', '# nothing yet\n')
    writeConfig(`scope:\n  scopeFile: ${JSON.stringify(file)}\n`)
    expect(readProjectScope(dir)).toEqual({ state: 'unset' })
  })
})

describe('readProjectScope — what could not be read is unknown, not unset', () => {
  it('a corrupt config.yaml is unknown', () => {
    writeConfig('scope: [unterminated\n  targets: {')
    expect(readProjectScope(dir)).toEqual({ state: 'unknown' })
  })

  it('a config.yaml that is not a mapping is unknown', () => {
    writeConfig('just a string\n')
    expect(readProjectScope(dir)).toEqual({ state: 'unknown' })
  })

  it('a config.yaml that cannot be read is unknown', () => {
    // A directory where the file should be: readFileSync fails with EISDIR,
    // which is not "the file does not exist".
    fs.mkdirSync(path.join(dir, 'config.yaml'))
    expect(readProjectScope(dir)).toEqual({ state: 'unknown' })
  })

  it('a missing scope file is unknown, and does not fall back to the targets alone', () => {
    writeConfig(`scope:\n  targets: [10.0.0.1]\n  scopeFile: ${JSON.stringify(path.join(dir, 'gone.txt'))}\n`)
    expect(readProjectScope(dir)).toEqual({ state: 'unknown' })
  })

  it('an invalid JSON scope file is unknown', () => {
    const file = writeScopeFile('scope.json', '{ not json')
    writeConfig(`scope:\n  targets: [10.0.0.1]\n  scopeFile: ${JSON.stringify(file)}\n`)
    expect(readProjectScope(dir)).toEqual({ state: 'unknown' })
  })
})
