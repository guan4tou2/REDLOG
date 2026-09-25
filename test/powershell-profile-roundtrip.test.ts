import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Install and uninstall must be inverses.
//
// On a machine where the operator had no `Documents\WindowsPowerShell\
// Microsoft.PowerShell_profile.ps1`, install created one holding nothing but
// RedLog's two lines — and uninstall then removed those two lines and left a
// 0-byte file, and the directory it had made, behind. Harmless to PowerShell,
// but it is a footprint on the operator's machine, which is the one thing a
// red-team tool has no business leaving.

let home: string
let hooks: typeof import('../src/core/hooks-manager')

const profiles = (): { wps: string; pwsh: string } => ({
  wps: path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  pwsh: path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
})

describe('the PowerShell profile install leaves nothing behind', () => {
  let restorePlatform: () => void
  let restoreEnv: () => void
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-psprofile-'))
    // `homedir()` reads USERPROFILE on Windows and HOME elsewhere; set both so
    // the test drives the same path the product does.
    const prev = { u: process.env.USERPROFILE, h: process.env.HOME }
    process.env.USERPROFILE = home
    process.env.HOME = home
    restoreEnv = () => { process.env.USERPROFILE = prev.u; process.env.HOME = prev.h }
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => Object.defineProperty(process, 'platform', desc)
    vi.resetModules()
    hooks = await import('../src/core/hooks-manager')
  })
  afterEach(() => {
    restorePlatform()
    restoreEnv()
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('removes a profile it created, and the directory it made for it', () => {
    const { wps } = profiles()
    expect(fs.existsSync(wps)).toBe(false)

    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.existsSync(wps)).toBe(true)
    expect(fs.readFileSync(wps, 'utf-8')).toMatch(/shell-hook\.ps1/)

    expect(hooks.uninstallHook('shell-powershell').success).toBe(true)
    expect(fs.existsSync(wps)).toBe(false)
    expect(fs.existsSync(path.dirname(wps))).toBe(false)
  })

  // The Windows PowerShell profile, not the pwsh one: install writes the pwsh
  // profile only when `pwsh` is on PATH, which it is not on a CI runner, and
  // this test is about content surviving rather than about which profile.
  it('keeps a profile the operator already had, minus our lines', () => {
    const pwsh = profiles().wps
    const original = 'Set-Alias ll Get-ChildItem\r\nfunction prompt { "PS> " }\r\n'
    fs.mkdirSync(path.dirname(pwsh), { recursive: true })
    fs.writeFileSync(pwsh, original)

    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.readFileSync(pwsh, 'utf-8')).toContain('Set-Alias ll Get-ChildItem')
    expect(fs.readFileSync(pwsh, 'utf-8')).toMatch(/shell-hook\.ps1/)

    expect(hooks.uninstallHook('shell-powershell').success).toBe(true)
    expect(fs.existsSync(pwsh)).toBe(true)
    const after = fs.readFileSync(pwsh, 'utf-8')
    expect(after).toContain('Set-Alias ll Get-ChildItem')
    expect(after).toContain('function prompt')
    expect(after).not.toMatch(/shell-hook\.ps1/)
  })

  it('does not touch a directory that holds anything else', () => {
    const { wps } = profiles()
    fs.mkdirSync(path.dirname(wps), { recursive: true })
    const neighbour = path.join(path.dirname(wps), 'Modules.txt')
    fs.writeFileSync(neighbour, 'mine')

    hooks.installHook('shell-powershell')
    hooks.uninstallHook('shell-powershell')

    expect(fs.existsSync(wps)).toBe(false)
    expect(fs.existsSync(neighbour)).toBe(true)
    expect(fs.existsSync(path.dirname(wps))).toBe(true)
  })
})
