import { describe, it, expect } from 'vitest'
import { buildShellCatalog, defaultShell, isHookable, type ShellProbe } from '../src/core/shell-catalog'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function probe(over: Partial<ShellProbe> = {}): ShellProbe {
  return {
    platform: 'win32',
    envShell: undefined,
    exists: () => false,
    wslDistros: [],
    ...over
  }
}

describe('shell catalog', () => {
  it('always offers PowerShell on Windows, and cmd.exe last', () => {
    const cat = buildShellCatalog(probe())
    expect(cat[0].id).toBe('powershell')
    expect(cat[cat.length - 1].id).toBe('cmd')
  })

  it('offers Git Bash when one is installed, as a hookable POSIX shell', () => {
    const cat = buildShellCatalog(probe({ exists: (p) => p === GIT_BASH }))
    const bash = cat.find((s) => s.id === 'git-bash')
    expect(bash?.command).toBe(GIT_BASH)
    expect(bash?.flavour).toBe('posix')
    expect(isHookable(bash!.flavour)).toBe(true)
  })

  it('leaves Git Bash out when none is installed', () => {
    expect(buildShellCatalog(probe()).some((s) => s.id === 'git-bash')).toBe(false)
  })

  it('offers PowerShell 7 only when it is there', () => {
    expect(buildShellCatalog(probe()).some((s) => s.id === 'pwsh')).toBe(false)
    const cat = buildShellCatalog(probe({ exists: (p) => p === PWSH7 }))
    expect(cat.find((s) => s.id === 'pwsh')?.flavour).toBe('powershell')
  })

  it('lists one entry per WSL distro, carrying the distro for /mnt conversion', () => {
    const cat = buildShellCatalog(probe({ wslDistros: ['Ubuntu', 'kali'] }))
    const ubuntu = cat.find((s) => s.id === 'wsl:Ubuntu')
    expect(ubuntu).toMatchObject({
      label: 'WSL · Ubuntu', command: 'wsl.exe', args: ['-d', 'Ubuntu'], flavour: 'posix', wslDistro: 'Ubuntu'
    })
    expect(cat.some((s) => s.id === 'wsl:kali')).toBe(true)
  })

  it('leaves out the distros Docker Desktop registers', () => {
    const cat = buildShellCatalog(probe({
      wslDistros: ['Ubuntu-26.04', 'docker-desktop', 'docker-desktop-data', 'kali-linux']
    }))
    const wsl = cat.filter((s) => s.id.startsWith('wsl:')).map((s) => s.id)
    expect(wsl).toEqual(['wsl:Ubuntu-26.04', 'wsl:kali-linux'])
  })

  it('marks cmd.exe as unhookable so the picker can say so before it is chosen', () => {
    const cmd = buildShellCatalog(probe()).find((s) => s.id === 'cmd')!
    expect(cmd.flavour).toBe('none')
    expect(isHookable(cmd.flavour)).toBe(false)
  })

  it('on POSIX puts the operator\'s own $SHELL first', () => {
    const cat = buildShellCatalog(probe({
      platform: 'darwin', envShell: '/opt/homebrew/bin/fish',
      exists: (p) => p === '/opt/homebrew/bin/fish' || p === '/bin/zsh' || p === '/bin/bash'
    }))
    expect(cat[0]).toMatchObject({ id: 'default', label: 'fish', flavour: 'none' })
    expect(cat.map((s) => s.id)).toContain('zsh')
    expect(cat.map((s) => s.id)).toContain('bash')
  })

  it('never lists the same shell twice', () => {
    const cat = buildShellCatalog(probe({
      platform: 'linux', envShell: '/bin/bash', exists: (p) => p === '/bin/bash'
    }))
    expect(cat.filter((s) => s.command === '/bin/bash').length).toBe(cat.length)
    expect(new Set(cat.map((s) => s.id)).size).toBe(cat.length)
  })

  describe('defaultShell', () => {
    it('honours the remembered choice', () => {
      const cat = buildShellCatalog(probe({ exists: (p) => p === GIT_BASH }))
      expect(defaultShell(cat, 'git-bash')?.id).toBe('git-bash')
      expect(defaultShell(cat, 'cmd')?.id).toBe('cmd')
    })

    it('falls back to a shell that can be recorded, not just the first one', () => {
      // A remembered id that no longer exists (distro removed, Git uninstalled)
      // must not silently drop the pane onto an unhookable shell.
      const cat = buildShellCatalog(probe({ exists: (p) => p === GIT_BASH }))
      expect(defaultShell(cat, 'wsl:gone')?.id).toBe('powershell')
      expect(isHookable(defaultShell(cat)!.flavour)).toBe(true)
    })

    it('returns null for an empty catalog', () => {
      expect(defaultShell([])).toBeNull()
    })
  })
})
