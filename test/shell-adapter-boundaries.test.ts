import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import starterPack from '../plugins/starter-pack/plugin.json'
import { STARTER_PACK_FALLBACK } from '../src/core/hooks-manager'

const read = (relative: string): string => fs.readFileSync(path.resolve(relative), 'utf8')

describe('shell adapter boundaries', () => {
  it('declares distinct bash and zsh adapters with one shared support file', () => {
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
      expect(producer?.supportFiles).toEqual(['hooks/shell-common.sh'])
      const fallback = STARTER_PACK_FALLBACK.find((candidate) => candidate.id === id)
      expect(fallback?.hookFile).toBe(hookFile)
      expect(fallback?.supportFiles).toEqual(['hooks/shell-common.sh'])
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

    const zsh = read('hooks/shell-zsh-hook.zsh')
    expect(zsh).toContain('source "$_redlog_adapter_dir/shell-common.sh"')
    expect(zsh).toContain('add-zsh-hook preexec')
    expect(zsh).not.toMatch(/curl -sf|active-identity\.json|pending/)
  })

  it('keeps the old combined hook as a compatibility delegator only', () => {
    const legacy = read('hooks/shell-preexec-hook.sh')
    expect(legacy).toContain('shell-bash-hook.sh')
    expect(legacy).toContain('shell-zsh-hook.zsh')
    expect(legacy).not.toContain('_redlog_send_event()')
  })

  it('keeps PowerShell on the shared shell event and output field contract', () => {
    const powershell = read('hooks/shell-hook.ps1')
    for (const field of [
      "agent_type = 'shell'", 'subtype = $Subtype', 'command = $Command',
      'exit_code', 'duration_sec', 'stdout', 'stderr', 'stdout_bytes',
      'stderr_bytes', 'stdout_truncated', 'stderr_truncated', "captured_by      = 'redlog-run'"
    ]) expect(powershell).toContain(field)
  })
})
