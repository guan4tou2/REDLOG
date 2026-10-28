import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Uninstalling RedLog kept every enrolment it had made. The PowerShell profile
// went on dot-sourcing ~/.redlog/shell-hook.ps1 (the uninstaller keeps
// ~/.redlog), so every new PowerShell window loaded a hook for an app that was
// gone. The uninstaller now runs the installed app once with --remove-hooks,
// and this is what that run does on the Windows side.

let home: string
let hooks: typeof import('../src/core/hooks-manager')

const profiles = (): { wps: string; pwsh: string } => ({
  wps: path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  pwsh: path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
})

describe('removing every enrolled hook on uninstall', () => {
  let restorePlatform: () => void
  let restoreEnv: () => void
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-uninstall-hooks-'))
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
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('takes the PowerShell lines out of a profile and keeps the operator\'s own', () => {
    const { wps } = profiles()
    fs.mkdirSync(path.dirname(wps), { recursive: true })
    fs.writeFileSync(wps, 'Set-Alias ll Get-ChildItem\r\n')
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.readFileSync(wps, 'utf8')).toContain('.redlog\\shell-hook.ps1')

    expect(hooks.removeInstalledHooks()).toEqual(['shell-powershell'])

    const after = fs.readFileSync(wps, 'utf8')
    expect(after).toContain('Set-Alias ll Get-ChildItem')
    expect(after).not.toContain('shell-hook.ps1')
    expect(after).not.toContain('# RedLog PowerShell hook')
  })

  it('removes a profile that install created', () => {
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.existsSync(profiles().wps)).toBe(true)

    expect(hooks.removeInstalledHooks()).toEqual(['shell-powershell'])
    expect(fs.existsSync(profiles().wps)).toBe(false)
  })

  // The operator may clear ~/.redlog by hand before uninstalling. The profile
  // then dot-sources a file that is gone, which PowerShell reports in every
  // new window — the line is what has to go, whether or not the copy is there.
  it('removes the profile line when the hook copy it names is already gone', () => {
    const { wps } = profiles()
    fs.mkdirSync(path.dirname(wps), { recursive: true })
    fs.writeFileSync(wps, 'Set-Alias ll Get-ChildItem\r\n')
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    fs.rmSync(path.join(home, '.redlog'), { recursive: true, force: true })

    expect(hooks.removeInstalledHooks()).toEqual(['shell-powershell'])
    expect(fs.readFileSync(wps, 'utf8')).not.toContain('shell-hook.ps1')
  })

  it('touches nothing when no shell is enrolled', () => {
    const { wps } = profiles()
    fs.mkdirSync(path.dirname(wps), { recursive: true })
    fs.writeFileSync(wps, 'Set-Alias ll Get-ChildItem\r\n')
    const before = fs.statSync(wps).mtimeMs

    expect(hooks.removeInstalledHooks()).toEqual([])
    expect(fs.readFileSync(wps, 'utf8')).toBe('Set-Alias ll Get-ChildItem\r\n')
    expect(fs.statSync(wps).mtimeMs).toBe(before)
  })
})
