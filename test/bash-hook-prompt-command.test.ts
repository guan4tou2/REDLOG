import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The bash adapter recorded the operator's PROMPT_COMMAND instead of what they
// typed, and dropped every real command behind it. Run a real interactive bash.
const HOOK = path.resolve(__dirname, '../hooks/shell-bash-hook.sh')

function run(promptCommand: string | null, commands: string[]): Array<[string, string]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bash-'))
  try {
    const script = [
      `HISTFILE=${dir}/hist`,
      promptCommand === null ? '' : `PROMPT_COMMAND='${promptCommand}'`,
      `source ${HOOK} 2>/dev/null`,
      '_redlog_send_event() { echo "EVENT $1 [$2]" >&2; }',
      ...commands,
      'exit'
    ].join('\n')
    const r = spawnSync('bash', ['--norc', '-i'], { input: script, env: { ...process.env, HOME: path.join(dir, 'home') }, encoding: 'utf8' })
    // Interactive bash puts its prompt before our marker on the same line.
    return [...r.stderr.matchAll(/EVENT (\w+) \[([^\]]*)\]/g)].map((m) => [m[1], m[2]] as [string, string]).filter(([, c]) => c !== 'exit')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

describe.skipIf(process.platform === 'win32')('bash adapter with an existing PROMPT_COMMAND', () => {
  const typed = ['echo one', 'pwd', 'echo three']
  const starts = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_start').map(([, c]) => c)
  const ends = (ev: Array<[string, string]>): string[] => ev.filter(([k]) => k === 'command_end').map(([, c]) => c)

  it.each([
    ['one command', 'history -a'],
    ['a function', 'myprecmd() { :; }; myprecmd'],
    ['a trailing semicolon', 'history -a;'],
    ['several commands', 'history -a; true; :']
  ])('records what was typed, not the prompt command: %s', (_n, pc) => {
    const ev = run(pc, typed)
    expect(starts(ev)).toEqual(typed)
    expect(ends(ev)).toEqual(typed)
  })

  it('does not record the hook itself on an empty Enter or a bare definition', () => {
    const ev = run('history -a', ['', 'f() { :; }', '', ...typed])
    expect(starts(ev)).toEqual(typed)
    expect(JSON.stringify(ev)).not.toContain('_redlog_')
  })

  it('still works with no PROMPT_COMMAND, and does not record the hook itself', () => {
    const ev = run(null, typed)
    expect(starts(ev)).toEqual(typed)
    expect(JSON.stringify(ev)).not.toContain('_redlog_')
  })
})
