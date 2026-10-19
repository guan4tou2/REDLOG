import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// An rc that sources the hook twice (relative and absolute path to the same
// file) must not announce twice, and a child shell must still load it.
const have = (exe: string): boolean => spawnSync(exe, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
const banners = (s: string): number => (s.match(/shell hook active/g) ?? []).length

function run(exe: 'bash' | 'zsh', hook: string, body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-dbl-'))
  try {
    return spawnSync(exe, ['-c', body], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home, _REDLOG_DIR: path.join(home, '.redlog'), HOOK: path.resolve(hook), EXE: exe }
    }).stdout
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

for (const [exe, hook] of [['bash', 'hooks/shell-bash-hook.sh'], ['zsh', 'hooks/shell-zsh-hook.zsh']] as const) {
  ;(have(exe) ? describe : describe.skip)(`${exe} hook sourced twice`, () => {
    it('announces once', () => {
      expect(banners(run(exe, hook, 'source "$HOOK"; source "$HOOK"'))).toBe(1)
    })
    it('a child shell started from it still loads and announces', () => {
      const out = run(exe, hook, 'source "$HOOK"; "$EXE" -c \'source "$HOOK"\'')
      expect(banners(out)).toBe(2)
    })
  })
}
