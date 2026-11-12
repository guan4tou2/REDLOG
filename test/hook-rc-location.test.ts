import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requires } from './helpers/requires'

// 09-F1: install wrote a guessed file and read "installed" back from the same
// file. zsh with ZDOTDIR (usually set in ~/.zshenv) reads $ZDOTDIR/.zshrc, and
// the login bash Terminal.app and iTerm2 start reads .bash_profile (or
// .bash_login, or .profile) — not .bashrc. Settings said installed; the shell
// never loaded the hook.
//
// Each case runs the real shell, in a throwaway HOME, and asks it whether the
// adapter loaded: `_REDLOG_HOOK_LOADED_IN` is the pid of the shell that
// loaded it, and the bash adapter's prompt command appears once per load, so
// "reachable exactly once" is countable. No PTY and no port: `-i -c` reads the
// startup files and runs one command.

const zsh = requires('zsh')
const bash = requires('bash')

let home: string
let hooks: typeof import('../src/core/hooks-manager')
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZDOTDIR: process.env.ZDOTDIR }

const file = (rel: string): string => path.join(home, rel)
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true })
  fs.writeFileSync(file(rel), text)
}
const read = (rel: string): string | null => fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), 'utf8') : null
const installed = (id: string): boolean | undefined => hooks.detectHooks().find((h) => h.id === id)?.installed

async function load(): Promise<void> {
  vi.resetModules()
  hooks = await import('../src/core/hooks-manager')
}

/** Starts the shell the way a terminal would, in the test HOME only. */
function shell(argv: string[], script: string): { stdout: string; stderr: string } {
  const [exe, ...flags] = argv
  const r = spawnSync(exe, [...flags, '-c', script], {
    encoding: 'utf8', timeout: 30_000, input: '',
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' }
  })
  expect(r.error, String(r.error)).toBeUndefined()
  return { stdout: r.stdout, stderr: r.stderr }
}

/** How many times the adapter loaded in that shell (0, 1, or more). */
function bashLoads(login: boolean): number {
  const { stdout } = shell(['bash', ...(login ? ['-l'] : []), '-i'],
    'printf "@@%s:%s\\n" "${_REDLOG_HOOK_LOADED_IN:-}" "$$"; printf "@@PC %s\\n" "${PROMPT_COMMAND:-}"')
  const [loaded, pid] = (/^@@(\d*):(\d+)$/m.exec(stdout) ?? ['', '', 'x']).slice(1)
  if (loaded !== pid) return 0
  const pc = /^@@PC (.*)$/m.exec(stdout)?.[1] ?? ''
  return pc.split('_redlog_prompt_command').length - 1
}

function zshLoaded(login: boolean): boolean {
  const { stdout } = shell(['zsh', ...(login ? ['-l'] : []), '-i'], 'print -r -- "@@${_REDLOG_HOOK_LOADED_IN:-}:$$"')
  const m = /^@@(\d*):(\d+)$/m.exec(stdout)
  return !!m && m[1] === m[2]
}

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-rcloc-')))
  process.env.HOME = home
  process.env.USERPROFILE = home
  // test/setup.ts points ZDOTDIR at an empty directory; these cases are about
  // the ZDOTDIR a terminal's zsh would get, so start from none.
  delete process.env.ZDOTDIR
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(home, { recursive: true, force: true })
})

zsh.describe('zsh honours ZDOTDIR set in ~/.zshenv', () => {
  beforeEach(async () => {
    write('.zshenv', 'export ZDOTDIR="$HOME/zdot"\n')
    fs.mkdirSync(file('zdot'))
    write('.zshrc', 'alias home-rc=true')
    await load()
  })

  it('installs into, detects in, and uninstalls from $ZDOTDIR/.zshrc, and leaves ~/.zshrc alone', () => {
    write('zdot/.zshrc', 'alias mine=true')
    const r = hooks.installHook('shell-zsh')
    expect(r.success, r.message).toBe(true)
    expect(r.message).toContain('~/zdot/.zshrc')
    expect(read('zdot/.zshrc')).toContain('# RedLog shell hook')
    expect(read('.zshrc')).toBe('alias home-rc=true')
    expect(installed('shell-zsh')).toBe(true)
    expect(zshLoaded(false)).toBe(true)
    expect(zshLoaded(true)).toBe(true)

    expect(hooks.uninstallHook('shell-zsh').success).toBe(true)
    expect(read('zdot/.zshrc')).toBe('alias mine=true')
    expect(read('.zshrc')).toBe('alias home-rc=true')
    expect(installed('shell-zsh')).toBe(false)
    expect(zshLoaded(false)).toBe(false)
  })

  it('a hook line only in ~/.zshrc, which this zsh does not read, is not reported installed — and uninstall still takes it out', async () => {
    // What an earlier RedLog did: the line went into ~/.zshrc.
    fs.renameSync(file('.zshenv'), file('zshenv.off'))
    await load()
    expect(hooks.installHook('shell-zsh').success).toBe(true)
    expect(read('.zshrc')).toContain('# RedLog shell hook')
    expect(installed('shell-zsh')).toBe(true)
    // Then ZDOTDIR came into play.
    fs.renameSync(file('zshenv.off'), file('.zshenv'))
    hooks.invalidateCommandCache()
    expect(zshLoaded(false)).toBe(false)
    expect(installed('shell-zsh')).toBe(false)

    expect(hooks.removeInstalledHooks()).toContain('shell-zsh')
    expect(read('.zshrc')).toBe('alias home-rc=true')
    expect(read('zdot/.zshrc')).toBeNull()
  })
})

bash.describe('bash: reachable from login and non-login interactive shells', () => {
  beforeEach(load)

  const cases: Array<{ name: string; files: Record<string, string>; touches: string[] }> = [
    { name: 'no login file', files: { '.bashrc': 'alias ll="ls -l"' }, touches: ['.bashrc', '.bash_profile'] },
    {
      name: '.bash_profile that sources .bashrc',
      files: { '.bashrc': 'alias ll="ls -l"\n', '.bash_profile': 'export A=1\n[ -f ~/.bashrc ] && . ~/.bashrc\n' },
      touches: ['.bashrc']
    },
    {
      name: '.bash_profile that does not source .bashrc (no final newline)',
      files: { '.bashrc': 'alias ll="ls -l"\n', '.bash_profile': 'export A=1' },
      touches: ['.bashrc', '.bash_profile']
    },
    {
      name: 'only .profile, not sourcing .bashrc',
      files: { '.profile': 'PATH="$PATH:$HOME/bin"\n' },
      touches: ['.bashrc', '.profile']
    },
    {
      name: 'only .profile, sourcing .bashrc the Debian way',
      files: {
        '.bashrc': 'alias ll="ls -l"\n',
        '.profile': 'if [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n'
      },
      touches: ['.bashrc']
    }
  ]
  const ALL = ['.bashrc', '.bash_profile', '.bash_login', '.profile']

  for (const c of cases) {
    it(c.name, () => {
      for (const [rel, text] of Object.entries(c.files)) write(rel, text)
      const before = Object.fromEntries(ALL.map((f) => [f, read(f)]))
      expect(installed('shell-bash')).toBe(false)

      const r = hooks.installHook('shell-bash')
      expect(r.success, r.message).toBe(true)
      for (const f of ALL) {
        if (c.touches.includes(f)) expect(read(f), `${f} was not written`).not.toBe(before[f])
        else expect(read(f), `${f} was written`).toBe(before[f])
      }
      // A new .bash_profile would hide an existing .profile from login bash.
      if (before['.profile'] !== null) expect(read('.bash_profile')).toBeNull()

      expect(installed('shell-bash')).toBe(true)
      expect(bashLoads(false), 'non-login interactive').toBe(1)
      expect(bashLoads(true), 'login interactive').toBe(1)

      expect(hooks.uninstallHook('shell-bash').success).toBe(true)
      for (const f of ALL) expect(read(f), `${f} after uninstall`).toBe(before[f])
      expect(installed('shell-bash')).toBe(false)
      expect(bashLoads(true)).toBe(0)
    }, 60_000)
  }

  it('a .bashrc line that no login file reaches is not reported installed', () => {
    // An earlier RedLog wrote only .bashrc; Terminal.app's login bash reads
    // .bash_profile, which does not load it.
    write('.bash_profile', 'export A=1\n')
    write('.bashrc', 'alias ll="ls -l"\n')
    expect(hooks.installHook('shell-bash').success).toBe(true)
    write('.bash_profile', 'export A=1\n')
    expect(bashLoads(true)).toBe(0)
    expect(installed('shell-bash')).toBe(false)
    // Still enrolled for removal and for the upgrade refresh.
    expect(hooks.removeInstalledHooks()).toContain('shell-bash')
    expect(read('.bashrc')).toBe('alias ll="ls -l"\n')
  })

  it('a login file that loads .bashrc in a way the text check misses still loads the adapter once', () => {
    // Both blocks are reached in one login shell; the second load must return.
    write('.bashrc', 'alias ll="ls -l"\n')
    write('.bash_profile', 'load() { . "$1"; }\nload ~/.bashrc\n')
    const before = read('.bash_profile')
    expect(hooks.installHook('shell-bash').success).toBe(true)
    expect(read('.bash_profile')).not.toBe(before)
    expect(bashLoads(true)).toBe(1)
    expect(bashLoads(false)).toBe(1)
    expect(hooks.uninstallHook('shell-bash').success).toBe(true)
    expect(read('.bash_profile')).toBe(before)
  })

  it('the login block is inert in sh and in a non-interactive login bash', () => {
    write('.profile', 'X=1\n')
    expect(hooks.installHook('shell-bash').success).toBe(true)
    const sh = spawnSync('/bin/sh', ['-c', '. "$HOME/.profile"; echo "@@${_REDLOG_HOOK_LOADED_IN:-none}"'], {
      encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH ?? '' }
    })
    expect(sh.status, sh.stderr).toBe(0)
    expect(sh.stderr).toBe('')
    const lc = spawnSync('bash', ['-l', '-c', 'echo "@@${_REDLOG_HOOK_LOADED_IN:-none}"'], {
      encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH ?? '' }
    })
    expect(lc.stdout).toContain('@@none')
    expect(lc.stderr).toBe('')
  })
})
