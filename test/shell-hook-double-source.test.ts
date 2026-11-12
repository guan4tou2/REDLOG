import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// An rc that sources the hook twice (relative and absolute path to the same
// file, or a login file and the .bashrc it loads) must register its prompt
// hook once, and a child shell must still load it. Loading prints nothing, so
// what is counted is the registration itself.
const have = (exe: string): boolean => spawnSync(exe, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0

const COUNT = {
  bash: 'printf "@@%s\\n" "$PROMPT_COMMAND"',
  zsh: 'print -r -- "@@${(j: :)precmd_functions}"'
} as const
const NEEDLE = { bash: '_redlog_prompt_command', zsh: '_redlog_precmd' } as const

function run(exe: 'bash' | 'zsh', hook: string, body: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-dbl-'))
  try {
    return spawnSync(exe, ['-c', body], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home, _REDLOG_DIR: path.join(home, '.redlog'), HOOK: path.resolve(hook), EXE: exe }
    }).stdout
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

const registrations = (exe: 'bash' | 'zsh', out: string): number[] =>
  out.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.split(NEEDLE[exe]).length - 1)

for (const [exe, hook] of [['bash', 'hooks/shell-bash-hook.sh'], ['zsh', 'hooks/shell-zsh-hook.zsh']] as const) {
  ;(have(exe) ? describe : describe.skip)(`${exe} hook sourced twice`, () => {
    it('registers once', () => {
      expect(registrations(exe, run(exe, hook, `source "$HOOK"; source "$HOOK"; ${COUNT[exe]}`))).toEqual([1])
    })
    it('a child shell started from it still loads', () => {
      const child = `source "$HOOK"; ${COUNT[exe]}`
      const out = run(exe, hook, `source "$HOOK"; ${COUNT[exe]}; "$EXE" -c '${child.replace(/'/g, `'\\''`)}'`)
      expect(registrations(exe, out)).toEqual([1, 1])
    })
  })
}
