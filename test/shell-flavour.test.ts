import { describe, it, expect } from 'vitest'
import { shellFlavour } from '../src/core/shell-flavour'

describe('shellFlavour', () => {
  it('classifies the Unix shells', () => {
    expect(shellFlavour('/bin/bash')).toBe('posix')
    expect(shellFlavour('/bin/zsh')).toBe('posix')
    expect(shellFlavour('/usr/bin/sh')).toBe('posix')
    expect(shellFlavour('/usr/local/bin/dash')).toBe('posix')
  })

  it('classifies PowerShell', () => {
    expect(shellFlavour('powershell.exe')).toBe('powershell')
    expect(shellFlavour('pwsh.exe')).toBe('powershell')
    expect(shellFlavour('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
  })

  it('treats a Windows bash as POSIX, not as "no hook"', () => {
    // The whole bug: `SHELL` is inherited, so every pane launched from a Git
    // Bash shell got this path, and the old predicate ("is it PowerShell?")
    // answered no and skipped the hook. The pane then recorded session_start
    // and a .cast and not one command, silently.
    expect(shellFlavour('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe('posix')
    expect(shellFlavour('C:\\msys64\\usr\\bin\\zsh.exe')).toBe('posix')
    expect(shellFlavour('C:/Program Files/Git/bin/bash.exe')).toBe('posix')
  })

  it('reports shells RedLog has no hook for', () => {
    // cmd.exe is the honest `none`: there is no hook, so the pane must say so
    // rather than be handed a POSIX hook path it can never source.
    expect(shellFlavour('C:\\WINDOWS\\system32\\cmd.exe')).toBe('none')
    expect(shellFlavour('cmd.exe')).toBe('none')
    expect(shellFlavour('/usr/bin/fish')).toBe('none')
    expect(shellFlavour('nu')).toBe('none')
  })

  it('is case-insensitive and tolerates a bare name', () => {
    expect(shellFlavour('BASH.EXE')).toBe('posix')
    expect(shellFlavour('PowerShell.exe')).toBe('powershell')
    expect(shellFlavour('bash')).toBe('posix')
  })
})
