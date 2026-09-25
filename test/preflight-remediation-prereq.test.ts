import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { runPreflight, remediationRequiresFor } from '../src/core/runtime-preflight'

// A remediation is a command the operator is told to run. `sudo apt` and
// `winget` ship with the systems that use them here; `uv` and `brew` do not,
// so a clean machine could be handed `uv tool install mitmproxy` with no uv on
// it — a fix that cannot be run, and nothing on screen to say why.
//
// The rule is tested directly rather than through a simulated PATH: an
// absolute path on Windows contains the colon a POSIX PATH splits on, so a
// `darwin` preflight driven from a Windows runner can never see its own temp
// bin directory.
describe('remediationRequiresFor', () => {
  const absent = (): boolean => false
  const present = (): boolean => true

  it('names uv when the remediation is a uv command and uv is missing', () => {
    const r = remediationRequiresFor('uv tool install mitmproxy', absent)
    expect(r?.command).toBe('uv')
    expect(r?.url).toMatch(/astral\.sh/)
  })

  it('names brew when the remediation is a brew command and brew is missing', () => {
    expect(remediationRequiresFor('brew install python', absent)?.command).toBe('brew')
  })

  it('says nothing extra once the installer is there', () => {
    expect(remediationRequiresFor('uv tool install mitmproxy', present)).toBeUndefined()
    expect(remediationRequiresFor('brew install python', present)).toBeUndefined()
  })

  it('leaves apt and winget alone — they come with the system that uses them', () => {
    expect(remediationRequiresFor('sudo apt install python3', absent)).toBeUndefined()
    expect(remediationRequiresFor('winget install --id Microsoft.PowerShell', absent)).toBeUndefined()
  })

  it('has nothing to say when there is no remediation', () => {
    expect(remediationRequiresFor(undefined, absent)).toBeUndefined()
  })
})

// One end-to-end pass on the real platform, so the field is actually wired
// through `runPreflight` and not merely exported.
describe('runPreflight carries the prerequisite through', () => {
  let bin: string
  beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-prereq-bin-')) })
  afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }) })

  it('reports mitmdump missing, with the installer it needs, on an empty PATH', () => {
    const r = runPreflight({ env: { PATH: bin, Path: bin, SHELL: '/bin/zsh' } })
    const mitm = r.checks.find((c) => c.id === 'mitmdump')!
    expect(mitm.found).toBe(false)
    expect(mitm.remediation).toBe('uv tool install mitmproxy')
    expect(mitm.remediationRequires?.command).toBe('uv')
  })
})
