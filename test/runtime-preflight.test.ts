import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Spec 036: the POSIX adapters build every event with python3 and send it with
// curl. A machine missing either used to show the zsh hook as available and
// then record nothing. These pin the dependency contract (requiresAll), the
// preflight report, legacy-profile migration, and the PowerShell one-click
// install — all against a temp HOME and an injected PATH.

let home: string
let bin: string
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, SHELL: process.env.SHELL }

function fakeCommand(name: string): void {
  // Both spellings so the probe also resolves on a Windows runner (PATHEXT).
  for (const file of [name, `${name}.exe`]) {
    fs.writeFileSync(path.join(bin, file), '#!/bin/sh\n')
    fs.chmodSync(path.join(bin, file), 0o755)
  }
}

function pretendPlatform(p: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

// hooks-manager bakes homedir() into install targets at module load, so every
// test imports it fresh after pointing HOME at the temp dir.
async function load() {
  vi.resetModules()
  const hooks = await import('../src/core/hooks-manager')
  const preflight = await import('../src/core/runtime-preflight')
  hooks.invalidateCommandCache()
  return { hooks, preflight }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-preflight-home-'))
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-preflight-bin-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PATH = bin
  process.env.SHELL = '/bin/zsh'
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(bin, { recursive: true, force: true })
})

describe('shell adapters require python3 AND curl (requiresAll)', () => {
  it.each([
    ['python3 missing', ['curl']],
    ['curl missing', ['python3']],
    ['both missing', []]
  ])('zsh and bash hooks are unavailable when %s', async (_label, present) => {
    for (const c of present) fakeCommand(c)
    const { hooks } = await load()
    const byId = new Map(hooks.detectHooks().map((h) => [h.id, h]))
    expect(byId.get('shell-zsh')?.available).toBe(false)
    expect(byId.get('shell-bash')?.available).toBe(false)
    const asyncById = new Map((await hooks.detectHooksAsync()).map((h) => [h.id, h]))
    expect(asyncById.get('shell-zsh')?.available).toBe(false)
  })

  it('zsh hook is available when both python3 and curl exist', async () => {
    fakeCommand('python3')
    fakeCommand('curl')
    const { hooks } = await load()
    expect(hooks.detectHooks().find((h) => h.id === 'shell-zsh')?.available).toBe(true)
    expect((await hooks.detectHooksAsync()).find((h) => h.id === 'shell-zsh')?.available).toBe(true)
  })

  it('the starter-pack manifest and the in-code fallback declare the same requiresAll', async () => {
    const { hooks } = await load()
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plugins', 'starter-pack', 'plugin.json'), 'utf-8')) as {
      builtinProducers: Array<{ id: string; requiresAll?: string[] }>
    }
    for (const id of ['shell-zsh', 'shell-bash']) {
      expect(manifest.builtinProducers.find((p) => p.id === id)?.requiresAll).toEqual(['python3', 'curl'])
      expect(hooks.STARTER_PACK_FALLBACK.find((p) => p.id === id)?.requiresAll).toEqual(['python3', 'curl'])
    }
  })
})

describe('runPreflight', () => {
  // POSIX PATH semantics (':' delimiter) cannot carry a Windows temp dir with a drive letter.
  it.skipIf(process.platform === 'win32')('lists exactly the missing commands, each with a copyable remediation', async () => {
    fakeCommand('curl')
    fakeCommand('zsh')
    fakeCommand('bash')
    const { preflight } = await load()
    const r = preflight.runPreflight({ platform: 'linux', env: { PATH: bin, SHELL: '/usr/bin/zsh' }, home })
    expect(r.platform).toBe('linux')
    expect(r.shell).toEqual({ name: 'zsh', hookId: 'shell-zsh' })
    const missing = r.checks.filter((c) => !c.found)
    expect(missing.map((c) => c.id).sort()).toEqual(['mitmdump', 'python3'])
    expect(missing.find((c) => c.id === 'python3')?.remediation).toBe('sudo apt install python3')
    expect(missing.find((c) => c.id === 'python3')?.neededFor).toEqual(expect.arrayContaining(['shell-zsh', 'shell-bash']))
    expect(missing.find((c) => c.id === 'mitmdump')?.remediation).toBe('uv tool install mitmproxy')
    // found checks carry no remediation
    expect(r.checks.filter((c) => c.found).every((c) => c.remediation === undefined)).toBe(true)
  })

  it('uses Homebrew remediation on macOS', async () => {
    const { preflight } = await load()
    const r = preflight.runPreflight({ platform: 'darwin', env: { PATH: bin, SHELL: '/bin/bash' }, home })
    expect(r.shell).toEqual({ name: 'bash', hookId: 'shell-bash' })
    expect(r.checks.find((c) => c.id === 'python3')?.remediation).toBe('brew install python')
    expect(r.checks.find((c) => c.id === 'curl')?.remediation).toBe('brew install curl')
  })

  it('reports PowerShell on Windows instead of the POSIX runtime', async () => {
    const { preflight } = await load()
    const r = preflight.runPreflight({ platform: 'win32', env: { Path: bin }, home })
    expect(r.shell?.hookId).toBe('shell-powershell')
    const ids = r.checks.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['pwsh', 'powershell', 'mitmdump']))
    expect(ids).not.toContain('zsh')
  })

  // Legacy-hook detection and migration are gone with the rest of the
  // pre-1.0 compatibility path (docs/UIUX-CONTROLS-AND-COPY.md, 2026-09-29):
  // RedLog no longer reads a profile it did not write.
})
