import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import starterPack from '../plugins/starter-pack/plugin.json'
import { STARTER_PACK_FALLBACK } from '../src/core/hooks-manager'
import { shellAdapterFilename } from '../src/core/shell-flavour'

const read = (relative: string): string => fs.readFileSync(path.resolve(relative), 'utf8')

// Everything an adapter sources or executes has to be installed beside it.
// `redlog-relay.py` joined the list in spec 052, when `redlog-run`'s own copy
// of the capture loop moved there: absent, the wrapper silently falls through
// to running the command unrecorded.
const SUPPORT_FILES = ['hooks/shell-common.sh', 'hooks/redlog-session.py', 'hooks/redlog-relay.py', 'hooks/command-class.json']

describe('shell adapter boundaries', () => {
  it('declares distinct bash and zsh adapters with their shared transport and session recorder', () => {
    const producers = starterPack.builtinProducers as Array<{
      id: string
      hookFile: string
      supportFiles?: string[]
    }>
    for (const [id, hookFile] of [
      ['shell-bash', 'hooks/shell-bash-hook.sh'],
      ['shell-zsh', 'hooks/shell-zsh-hook.zsh']
    ]) {
      const producer = producers.find((candidate) => candidate.id === id)
      expect(producer?.hookFile).toBe(hookFile)
      expect(producer?.supportFiles).toEqual(SUPPORT_FILES)
      const fallback = STARTER_PACK_FALLBACK.find((candidate) => candidate.id === id)
      expect(fallback?.hookFile).toBe(hookFile)
      expect(fallback?.supportFiles).toEqual(SUPPORT_FILES)
    }
  })

  it('keeps transport in common and lifecycle code in thin adapters', () => {
    const common = read('hooks/shell-common.sh')
    expect(common).toContain('_redlog_send_event()')
    expect(common).toContain('redlog-run()')
    expect(common).not.toMatch(/add-zsh-hook|PROMPT_COMMAND|trap '_redlog_debug_trap'/)

    const bash = read('hooks/shell-bash-hook.sh')
    expect(bash).toContain('source "$_redlog_adapter_dir/shell-common.sh"')
    expect(bash).toContain('_redlog_debug_trap()')
    expect(bash).not.toMatch(/curl -sf|active-identity\.json|pending/)
    expect(bash).toContain('\\"cwd\\"')

    const zsh = read('hooks/shell-zsh-hook.zsh')
    expect(zsh).toContain('source "$_redlog_adapter_dir/shell-common.sh"')
    expect(zsh).toContain('add-zsh-hook preexec')
    expect(zsh).not.toMatch(/curl -sf|active-identity\.json|pending/)
    expect(zsh).toContain('\\"cwd\\"')
  })

  it('does not ship historical combined hook entry points', () => {
    expect(fs.existsSync(path.resolve('hooks/shell-preexec-hook.sh'))).toBe(false)
    expect(fs.existsSync(path.resolve('shell/redlog-hook.zsh'))).toBe(false)
  })

  it('routes each built-in terminal shell to its current adapter', () => {
    expect(shellAdapterFilename('/bin/bash')).toBe('shell-bash-hook.sh')
    expect(shellAdapterFilename('/bin/zsh')).toBe('shell-zsh-hook.zsh')
    expect(shellAdapterFilename('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('shell-bash-hook.sh')
    expect(shellAdapterFilename('powershell.exe')).toBe('shell-hook.ps1')
    expect(shellAdapterFilename('wsl.exe', '/bin/bash')).toBe('shell-bash-hook.sh')
    expect(shellAdapterFilename('wsl.exe', '/bin/zsh')).toBe('shell-zsh-hook.zsh')
    expect(shellAdapterFilename('/bin/sh')).toBeNull()
    expect(shellAdapterFilename('cmd.exe')).toBeNull()
  })

  it('keeps PowerShell on the shared shell event and output field contract', () => {
    const powershell = read('hooks/shell-hook.ps1')
    for (const field of [
      "agent_type = 'shell'", 'subtype = $Subtype', 'command = $Command',
      'exit_code', 'duration_sec', 'stdout', 'stderr', 'stdout_bytes',
      'stderr_bytes', 'stdout_truncated', 'stderr_truncated', "captured_by      = 'redlog-run'"
    ]) expect(powershell).toContain(field)
    expect(powershell).toContain('cwd = (Get-Location).Path')
  })
})
