import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const bash = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0

;(bash ? describe : describe.skip)('shell capture announcement', () => {
  it('advertises the terminal controls only for adapters that have them', () => {
    const say = (shell: string): string => spawnSync('bash', ['-c', 'source "$1"; _REDLOG_ADAPTER_SHELL=$2; _redlog_announce_shell commands', 'redlog-banner', path.resolve('hooks/shell-common.sh'), shell], { encoding: 'utf8' }).stdout
    expect(say('bash')).toMatch(/redlog status/)
    expect(say('zsh')).toMatch(/redlog stop/)
    // An adapter without `redlog` must not point at a command that is not there.
    expect(say('sh')).not.toMatch(/redlog status|redlog stop/)
    expect(say('sh')).toContain('commands will be recorded')
  })
})
