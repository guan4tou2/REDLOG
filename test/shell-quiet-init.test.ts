import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requires } from './helpers/requires'

// 09-F5 and the 2026-11-12 decision "Shell 啟動時的輸出": the hook prints
// nothing while the shell initialises. Two lines on stdout at every start
// reached every nested shell and tmux pane, broke scp/rsync into an rc with no
// interactive guard, and is exactly what instant-prompt frameworks warn about.
// "Loaded" is `redlog status`; a state CHANGE is said once, on stderr, at the
// next prompt.
//
// Measured against the same shell started with no hook at all, so what bash
// itself says (`no job control`, `exit`, `logout`) is not counted as ours.

const zsh = requires('zsh')
const bash = requires('bash')

const REFUSED = '[redlog] this terminal is not recorded — RedLog is set to record only in'

let home: string
let bare: string
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZDOTDIR: process.env.ZDOTDIR }

function start(h: string, argv: string[], input = ''): { stdout: string; stderr: string } {
  const [exe, ...flags] = argv
  const r = spawnSync(exe, flags, {
    encoding: 'utf8', timeout: 60_000, input,
    env: { HOME: h, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' }
  })
  expect(r.error, String(r.error)).toBeUndefined()
  return { stdout: r.stdout, stderr: r.stderr }
}

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-quiet-')))
  bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-quiet-bare-')))
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.ZDOTDIR
  vi.resetModules()
  const hooks = await import('../src/core/hooks-manager')
  for (const id of ['shell-zsh', 'shell-bash']) {
    const r = hooks.installHook(id)
    expect(r.success, r.message).toBe(true)
  }
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(bare, { recursive: true, force: true })
})

const variants: Array<{ need: typeof zsh; argv: string[] }> = [
  { need: zsh, argv: ['zsh', '-i', '-c', 'exit'] },
  { need: zsh, argv: ['zsh', '-l', '-i', '-c', 'exit'] },
  { need: bash, argv: ['bash', '-i', '-c', 'exit'] },
  { need: bash, argv: ['bash', '-l', '-i', '-c', 'exit'] }
]

describe('the hook says nothing while a shell starts', () => {
  for (const v of variants) {
    v.need.it(`${v.argv.join(' ')}: not one byte on stdout or stderr`, () => {
      const loaded = start(home, [...v.argv.slice(0, -1), 'print -r -- "@@${_REDLOG_HOOK_LOADED_IN:-}" 2>/dev/null || printf "@@%s\\n" "${_REDLOG_HOOK_LOADED_IN:-}"'])
      expect(loaded.stdout, 'the hook did not load, so its silence proves nothing').toMatch(/^@@\d+$/m)
      const withHook = start(home, v.argv)
      const without = start(bare, v.argv)
      expect(withHook.stdout).toBe(without.stdout)
      expect(withHook.stderr).toBe(without.stderr)
    }, 60_000)
  }

  for (const [need, exe] of [[zsh, 'zsh'], [bash, 'bash']] as const) {
    need.it(`${exe}, refused by the terminal-app selection: silent at start, one line at the first prompt`, () => {
      fs.writeFileSync(path.join(home, '.redlog', 'terminal-app'), 'NoSuchTerminal\n')
      const init = start(home, [exe, '-i', '-c', 'exit'])
      const initBare = start(bare, [exe, '-i', '-c', 'exit'])
      expect(init.stdout + init.stderr).toBe(initBare.stdout + initBare.stderr)

      const session = start(home, [exe, '-i'], 'echo one\necho two\necho three\n')
      const said = (session.stdout + session.stderr).split(REFUSED).length - 1
      expect(said, session.stdout + session.stderr).toBe(1)
      expect(session.stderr).toContain(`${REFUSED} NoSuchTerminal`)
    }, 60_000)
  }
})
