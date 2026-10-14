import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const bash = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0

;(bash ? describe : describe.skip)('shell capture announcement', () => {
  it('does not advertise Zsh-only controls in Bash', () => {
    const result = spawnSync('bash', ['-c', 'source "$1"; _REDLOG_ADAPTER_SHELL=bash; _redlog_announce_shell commands', 'redlog-banner', path.resolve('hooks/shell-common.sh')], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('commands will be recorded')
    expect(result.stdout).not.toMatch(/redlog status|redlog stop/)
  })
})
