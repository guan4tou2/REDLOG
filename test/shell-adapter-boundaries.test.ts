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
const SUPPORT_FILES = ['hooks/shell-common.sh', 'hooks/redlog-session.py', 'hooks/redlog-relay.py', 'hooks/terminal_app.py', 'hooks/command-class.json']

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

  // #499 PR B. Where the report goes is the relay's business and when to take it
  // is the adapter's; neither adapter learns the directory, and both ask the
  // same shared function, once, at the first prompt.
  it('keeps tool detection in common: the adapters only say when, and never where', () => {
    const common = read('hooks/shell-common.sh')
    expect(common).toContain('_redlog_report_tools()')
    expect(common).not.toContain('tool-detection')
    // Gated on the one recording rule, and the flag set only after the gate.
    const report = common.slice(common.indexOf('_redlog_report_tools() {'))
    const gate = report.indexOf('_redlog_is_recording || return 0')
    expect(gate).toBeGreaterThan(-1)
    expect(report.indexOf('_REDLOG_TOOLS_REPORTED=1')).toBeGreaterThan(gate)
    for (const adapter of ['hooks/shell-bash-hook.sh', 'hooks/shell-zsh-hook.zsh']) {
      const text = read(adapter)
      expect(text, adapter).not.toContain('tool-detection')
      expect(text, adapter).not.toContain(' detect ')
      expect(text.match(/_redlog_report_tools$/gm), adapter).toBeNull()
      expect(text.match(/_redlog_report_tools; fi/g), adapter).toHaveLength(1)
      expect(text, adapter).toContain('_REDLOG_TOOLS_REPORTED=""')
      expect(text, adapter).not.toMatch(/export\s+_REDLOG_TOOLS_REPORTED/)
    }
  })

  // The first prompt of a shell has no command before it, which is exactly the
  // prompt `_redlog_precmd` returns early from. A guard below that return is a
  // report at the first COMMAND's prompt, and the PTY tests alone had stayed
  // green with it moved (a late report still shows up). Order is the contract.
  it('takes the report before anything that depends on a command having run', () => {
    const body = (text: string, name: string): string => {
      const start = text.indexOf(`${name}() {`)
      expect(start, `${name} exists`).toBeGreaterThan(-1)
      return text.slice(start, text.indexOf('\n}\n', start)).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    }
    for (const [file, fn] of [['hooks/shell-zsh-hook.zsh', '_redlog_precmd'], ['hooks/shell-bash-hook.sh', '_redlog_prompt_command']]) {
      const text = body(read(file), fn)
      const guard = text.indexOf('_redlog_report_tools')
      expect(guard, `${file}: the guard is in ${fn}`).toBeGreaterThan(-1)
      expect(guard, `${file}: before the first use of the last command`).toBeLessThan(text.indexOf('_REDLOG_LAST_CMD'))
      expect(guard, `${file}: before the first return`).toBeLessThan(text.indexOf('return'))
    }
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
