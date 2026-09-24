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
  it('lists exactly the missing commands, each with a copyable remediation', async () => {
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

  it('includes legacy hook references', async () => {
    fs.writeFileSync(path.join(home, '.zshrc'), 'source ~/.redlog/shell-preexec-hook.sh\n')
    const { preflight } = await load()
    const r = preflight.runPreflight({ platform: 'linux', env: { PATH: bin }, home })
    expect(r.legacyHooks).toHaveLength(1)
  })
})

describe('legacy hook references', () => {
  it('finds retired source lines across rc files and PowerShell profiles', async () => {
    fs.writeFileSync(path.join(home, '.zshrc'), [
      'export FOO=1',
      '# RedLog shell hook',
      'source ~/.redlog/shell-preexec-hook.sh',
      '# source ~/old/redlog-hook.zsh',
      '. /opt/redlog/shell/redlog-hook.zsh',
      'source ~/.redlog/shell-hook.zsh'
    ].join('\n'))
    fs.writeFileSync(path.join(home, '.bash_profile'), 'source "$HOME/.redlog/shell-preexec-hook.sh"\n')
    const { preflight } = await load()
    const refs = preflight.findLegacyHookReferences({ home })
    expect(refs.map((r) => [path.basename(r.file), r.line, r.hookId])).toEqual([
      ['.zshrc', 3, 'shell-zsh'],
      ['.zshrc', 5, 'shell-zsh'],
      ['.bash_profile', 1, 'shell-bash']
    ])
    expect(refs[0].text).toBe('source ~/.redlog/shell-preexec-hook.sh')
  })

  it('migration backs up the rc, removes the legacy lines and installs the current adapter', async () => {
    fakeCommand('python3')
    fakeCommand('curl')
    const rc = path.join(home, '.zshrc')
    fs.writeFileSync(rc, 'export FOO=1\n# RedLog shell hook\nsource ~/.redlog/shell-preexec-hook.sh\nalias ll="ls -l"\n')
    const restore = process.platform === 'win32' ? pretendPlatform('darwin') : () => {}
    try {
      const { preflight } = await load()
      const [ref] = preflight.findLegacyHookReferences({ home })
      const result = preflight.migrateLegacyHook(ref, { home })
      expect(result.success).toBe(true)
      expect(result.backupPath).toMatch(/\.zshrc\.redlog-bak-\d+$/)
      expect(fs.readFileSync(result.backupPath!, 'utf-8')).toContain('shell-preexec-hook.sh')
      const after = fs.readFileSync(rc, 'utf-8')
      expect(after).not.toContain('shell-preexec-hook.sh')
      expect(after).toContain('export FOO=1')
      expect(after).toContain('alias ll="ls -l"')
      expect(after).toContain(`source ${path.join(home, '.redlog', 'shell-hook.zsh')}`)
      expect(fs.existsSync(path.join(home, '.redlog', 'shell-hook.zsh'))).toBe(true)
      expect(preflight.findLegacyHookReferences({ home })).toEqual([])
    } finally { restore() }
  })

  it('migration refuses a file outside the scanned rc set and never throws', async () => {
    const { preflight } = await load()
    const outside = path.join(home, 'notes.txt')
    fs.writeFileSync(outside, 'source shell-preexec-hook.sh\n')
    const r = preflight.migrateLegacyHook({ file: outside, line: 1, text: 'x', hookId: 'shell-zsh' }, { home })
    expect(r.success).toBe(false)
    expect(fs.readFileSync(outside, 'utf-8')).toContain('shell-preexec-hook.sh')
    expect(preflight.migrateLegacyHook(null as never, { home }).success).toBe(false)
  })
})

describe('PowerShell one-click install (win32)', () => {
  let restore: () => void
  beforeEach(() => { restore = pretendPlatform('win32') })
  afterEach(() => restore())

  it('copies the hook, creates the profile and appends the dot-source line once', async () => {
    const { hooks } = await load()
    const profile = path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    expect(hooks.detectHooks().find((h) => h.id === 'shell-powershell')?.installed).toBe(false)
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.existsSync(path.join(home, '.redlog', 'shell-hook.ps1'))).toBe(true)
    const content = fs.readFileSync(profile, 'utf-8')
    const line = '. "$HOME\\.redlog\\shell-hook.ps1"'
    expect(content.split(line).length - 1).toBe(1)
    const ps = hooks.detectHooks().find((h) => h.id === 'shell-powershell')!
    expect(ps.installed).toBe(true)
    expect(ps.installMethod).not.toBe('manual')
    // manual steps survive as the fallback text
    expect(ps.manualSteps?.length).toBeGreaterThan(0)
  })

  it('also wires the PowerShell 7 profile when pwsh is on PATH, and uninstall removes the line', async () => {
    fakeCommand('pwsh')
    const { hooks } = await load()
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    const pwshProfile = path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    expect(fs.readFileSync(pwshProfile, 'utf-8')).toContain('.redlog\\shell-hook.ps1')
    expect(hooks.uninstallHook('shell-powershell').success).toBe(true)
    expect(fs.readFileSync(pwshProfile, 'utf-8')).not.toContain('.redlog\\shell-hook.ps1')
    expect(hooks.detectHooks().find((h) => h.id === 'shell-powershell')?.installed).toBe(false)
  })
})
