import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { runPreflight } from '../src/core/runtime-preflight'

// A remediation is a command the operator is told to run. `sudo apt` and
// `winget` ship with the systems that use them here; `uv` and `brew` do not.
// So a clean machine could be handed `uv tool install mitmproxy` with no uv on
// it — a fix that cannot be run, and nothing on screen to say why.

let bin: string

function fakeCommand(name: string): void {
  for (const file of [name, `${name}.exe`]) {
    fs.writeFileSync(path.join(bin, file), '#!/bin/sh\n')
    fs.chmodSync(path.join(bin, file), 0o755)
  }
}

const check = (platform: NodeJS.Platform, id: string) =>
  runPreflight({ platform, env: { PATH: bin, SHELL: '/bin/zsh' } }).checks.find((c) => c.id === id)

describe('a remediation names the installer it needs', () => {
  beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-prereq-bin-')) })
  afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }) })

  it('names uv when mitmproxy is missing and uv is not installed', () => {
    const mitm = check('darwin', 'mitmdump')!
    expect(mitm.found).toBe(false)
    expect(mitm.remediation).toBe('uv tool install mitmproxy')
    expect(mitm.remediationRequires?.command).toBe('uv')
    expect(mitm.remediationRequires?.url).toMatch(/astral\.sh/)
  })

  it('says nothing extra once the installer is there', () => {
    fakeCommand('uv')
    const mitm = check('darwin', 'mitmdump')!
    expect(mitm.remediation).toBe('uv tool install mitmproxy')
    expect(mitm.remediationRequires).toBeUndefined()
  })

  it('names brew for a brew remediation on a machine without it', () => {
    const py = check('darwin', 'python3')!
    expect(py.remediation).toBe('brew install python')
    expect(py.remediationRequires?.command).toBe('brew')
  })

  it('leaves apt and winget alone — they come with the system that uses them', () => {
    expect(check('linux', 'python3')?.remediation).toBe('sudo apt install python3')
    expect(check('linux', 'python3')?.remediationRequires).toBeUndefined()
    expect(check('win32', 'pwsh')?.remediationRequires).toBeUndefined()
  })

  it('offers no remediation at all for a dependency that is present', () => {
    fakeCommand('python3')
    const py = check('darwin', 'python3')!
    expect(py.found).toBe(true)
    expect(py.remediation).toBeUndefined()
    expect(py.remediationRequires).toBeUndefined()
  })
})
