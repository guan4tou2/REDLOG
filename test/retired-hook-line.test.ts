import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requires } from './helpers/requires'
import { rcWithoutRetiredHooks, retiredHookLineNumbers } from '../src/core/retired-hook-lines'

// #879. Until 2026-09-22 the bash install wrote a `source` of
// `~/.redlog/shell-preexec-hook.sh` into `~/.bashrc`. The file left the
// product and the line stayed: every new shell printed "No such file or
// directory" and recorded nothing, and install, removal and Settings matched
// the current filename only, so none of them could see it. Found on a Windows
// machine, in Git Bash's `.bashrc`.

const RETIRED = 'shell-preexec-hook.sh'
const MARKER = '# RedLog shell hook'
const OWN = 'alias mine=true\n'
/** What the old installer appended, byte for byte. */
const oldBlock = (dest: string): string => `\n${MARKER}\nsource ${dest}\n`

describe('recognising the retired hook line', () => {
  it('finds the block the old installer wrote, and removal leaves the file as it was before that install', () => {
    const rc = OWN + oldBlock('/home/op/.redlog/shell-preexec-hook.sh')
    expect(retiredHookLineNumbers(rc)).toEqual([4])
    expect(rcWithoutRetiredHooks(rc)).toBe(OWN)
  })

  it('finds the line as it stood on the machine it was reported from: an MSYS path, nothing else in the file', () => {
    const rc = oldBlock('/c/Users/op/.redlog/shell-preexec-hook.sh')
    expect(retiredHookLineNumbers(rc)).toEqual([3])
    expect(rcWithoutRetiredHooks(rc)).toBe('')
  })

  // The installer wrote the absolute path; the operator may have respelled it
  // since, as Git Bash needs.
  for (const path of [
    '~/.redlog/shell-preexec-hook.sh',
    '"$HOME/.redlog/shell-preexec-hook.sh"',
    "'/c/Users/First Last/.redlog/shell-preexec-hook.sh'",
    'C:\\Users\\op\\.redlog\\shell-preexec-hook.sh'
  ]) {
    it(`knows the block under any spelling of the path: ${path}`, () => {
      const rc = `export A=1\n${oldBlock(path)}export B=2\n`
      expect(retiredHookLineNumbers(rc)).toEqual([4])
      expect(rcWithoutRetiredHooks(rc)).toBe('export A=1\nexport B=2\n')
    })
  }

  it('keeps CRLF line endings on everything it leaves', () => {
    const rc = `a=1\r\n\r\n${MARKER}\r\nsource ~/.redlog/${RETIRED}\r\nb=2\r\n`
    expect(retiredHookLineNumbers(rc)).toEqual([4])
    expect(rcWithoutRetiredHooks(rc)).toBe('a=1\r\nb=2\r\n')
  })

  it('leaves the current hook, and its marker, beside a retired block', () => {
    const current = oldBlock('/home/op/.redlog/shell-bash-hook.sh')
    const rc = oldBlock(`/home/op/.redlog/${RETIRED}`) + current
    expect(rcWithoutRetiredHooks(rc)).toBe(current)
  })

  // Only a line under RedLog's marker is RedLog's. Each of these is the
  // operator's own, and several stop being valid shell with one line gone:
  // the body of an `if` or a function leaves `then`/`{` facing `fi`/`}`.
  for (const [what, rc] of Object.entries({
    'a bare line': `export A=1\nsource ~/.redlog/${RETIRED}\nexport B=2\n`,
    'a dot-sourced line': `. ~/.redlog/${RETIRED}\n`,
    'the body of an if, not indented': `if [ -f ~/.redlog/${RETIRED} ]; then\nsource ~/.redlog/${RETIRED}\nfi\n`,
    'the body of an if, indented': `if [ -f ~/.redlog/${RETIRED} ]; then\n  source ~/.redlog/${RETIRED}\nfi\n`,
    'the body of a function': `rl() {\nsource ~/.redlog/${RETIRED}\n}\n`,
    'a guarded one-liner': `[ -f ~/.redlog/${RETIRED} ] && source ~/.redlog/${RETIRED}\n`,
    'a commented line': `# source ~/.redlog/${RETIRED}\n`,
    'a line that goes on': `${MARKER}\nsource ~/.redlog/${RETIRED}; echo loaded\n`,
    'a marker that is not directly above': `${MARKER}\n\nsource ~/.redlog/${RETIRED}\n`,
    'another file under the marker': `${MARKER}\nsource ~/.redlog/my-${RETIRED}\n${MARKER}\nsource ~/.redlog/${RETIRED}.bak\n`,
    'the current hook': `\n${MARKER}\nsource ~/.redlog/shell-bash-hook.sh\n`,
    'a mention': `echo ${RETIRED}\n`
  })) {
    it(`leaves alone ${what}`, () => {
      expect(retiredHookLineNumbers(rc)).toEqual([])
      expect(rcWithoutRetiredHooks(rc)).toBe(rc)
    })
  }
})

// --- against the installer, in a throwaway HOME --------------------------

let home: string
let hooks: typeof import('../src/core/hooks-manager')
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

const file = (rel: string): string => path.join(home, rel)
const write = (rel: string, text: string): void => fs.writeFileSync(file(rel), text)
const read = (rel: string): string | null => fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), 'utf8') : null
const count = (text: string | null, needle: string): number => (text ?? '').split(needle).length - 1
const bash = (): import('../src/core/hooks-manager').PluginInfo => hooks.detectHooks().find((h) => h.id === 'shell-bash')!
/** The line as an old install left it in this HOME. */
const retiredBlock = (): string => oldBlock(`${home.replace(/\\/g, '/')}/.redlog/${RETIRED}`)

/** rc-file install is refused on Windows, where the line was found, and a
 *  Windows host looks the PowerShell profile up through PowerShell, which
 *  answers with the real one whatever HOME says. What is under test is plain
 *  file I/O on an rc, so a Windows host runs it as the POSIX platform it was
 *  written for; elsewhere this changes nothing. */
function asPosixHost(): void {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
}

/** A read-only file stops nobody who is root. No CI leg runs as root. */
const readOnly = { it: process.getuid?.() === 0 ? it.skip : it }

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-retired-')))
  process.env.HOME = home
  process.env.USERPROFILE = home
  vi.resetModules()
  hooks = await import('../src/core/hooks-manager')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(home, { recursive: true, force: true })
})

describe('Settings names the retired line', () => {
  beforeEach(asPosixHost)

  it('reports the file and the line on the bash row, and on no other', () => {
    write('.bashrc', OWN + retiredBlock())
    expect(bash().retiredLines).toEqual([{ file: file('.bashrc'), line: 4 }])
    expect(bash().installed).toBe(false)
    expect(hooks.detectHooks().filter((h) => h.retiredLines).map((h) => h.id)).toEqual(['shell-bash'])
  })

  it('finds the block in a login file as well, and not a bare line the operator wrote there', () => {
    write('.bash_profile', `export EDITOR=vi\n${retiredBlock()}`)
    write('.profile', `. ~/.redlog/${RETIRED}\n`)
    expect(bash().retiredLines).toEqual([{ file: file('.bash_profile'), line: 4 }])
  })

  it('reports nothing for an rc that only has the current hook', () => {
    write('.bashrc', OWN + oldBlock(`${home}/.redlog/shell-bash-hook.sh`))
    expect(bash().retiredLines).toBeUndefined()
  })
})

describe('removing the retired line on its own', () => {
  beforeEach(asPosixHost)

  it('takes the block out, keeps the rest byte for byte, and reports nothing afterwards', () => {
    write('.bashrc', OWN + retiredBlock())
    const r = hooks.removeRetiredHookLines('shell-bash')
    expect(r.success, r.message).toBe(true)
    expect(r.message).toContain('.bashrc')
    expect(read('.bashrc')).toBe(OWN)
    expect(bash().retiredLines).toBeUndefined()
    expect(hooks.removeRetiredHookLines('shell-bash')).toEqual({ success: true, message: 'Already removed', changed: [] })
  })

  readOnly.it('says so when the file cannot be written, and leaves it as it was', () => {
    write('.bashrc', OWN + retiredBlock())
    fs.chmodSync(file('.bashrc'), 0o444)
    try {
      const r = hooks.removeRetiredHookLines('shell-bash')
      expect(r.success).toBe(false)
      expect(r.message).toContain('.bashrc')
      expect(r.changed).toEqual([])
    } finally {
      fs.chmodSync(file('.bashrc'), 0o644)
    }
    expect(read('.bashrc')).toBe(OWN + retiredBlock())
    expect(bash().retiredLines).toHaveLength(1)
  })

  it('does not leave an empty file where the block was all there was', () => {
    write('.bashrc', retiredBlock())
    expect(hooks.removeRetiredHookLines('shell-bash').success).toBe(true)
    expect(read('.bashrc')).toBeNull()
  })

  it('leaves a working hook in the same file alone', () => {
    const current = oldBlock(`${home}/.redlog/shell-bash-hook.sh`)
    write('.bashrc', OWN + retiredBlock() + current)
    expect(hooks.removeRetiredHookLines('shell-bash').success).toBe(true)
    expect(read('.bashrc')).toBe(OWN + current)
  })

  it('refuses any id but bash', () => {
    write('.bashrc', OWN + retiredBlock())
    for (const id of ['shell-zsh', 'shell-powershell', 'mitmproxy', 'nope', '']) {
      expect(hooks.removeRetiredHookLines(id).success, id).toBe(false)
    }
    expect(read('.bashrc')).toBe(OWN + retiredBlock())
  })
})

describe('installing the current hook over the retired line', () => {
  beforeEach(asPosixHost)

  it('removes the line and leaves the current hook in the rc exactly once', () => {
    write('.bashrc', OWN + retiredBlock())
    const r = hooks.installHook('shell-bash')
    expect(r.success, r.message).toBe(true)
    expect(r.message).toContain('no longer ships')

    const rc = read('.bashrc')
    expect(rc).not.toContain(RETIRED)
    expect(rc?.startsWith(OWN)).toBe(true)
    expect(count(rc, 'shell-bash-hook.sh')).toBe(1)
    expect(count(rc, MARKER)).toBe(1)
    expect(bash().retiredLines).toBeUndefined()
    expect(bash().installed).toBe(true)

    // Installing again adds nothing.
    expect(hooks.installHook('shell-bash').success).toBe(true)
    expect(read('.bashrc')).toBe(rc)
  })

  it('takes it out of a login file too, and that file still gets the current hook', () => {
    write('.bash_profile', `export EDITOR=vi\n${retiredBlock()}`)
    expect(hooks.installHook('shell-bash').success).toBe(true)
    expect(read('.bash_profile')).not.toContain(RETIRED)
    expect(read('.bash_profile')?.startsWith('export EDITOR=vi\n')).toBe(true)
    expect(count(read('.bash_profile'), 'shell-bash-hook.sh')).toBe(1)
    expect(count(read('.bashrc'), 'shell-bash-hook.sh')).toBe(1)
  })

  it('a login file that held only the block is gone, and the hook goes into the one bash reads next', () => {
    write('.bash_profile', retiredBlock())
    write('.profile', 'export EDITOR=vi\n')
    expect(hooks.installHook('shell-bash').success).toBe(true)
    expect(read('.bash_profile')).toBeNull()
    expect(count(read('.profile'), 'shell-bash-hook.sh')).toBe(1)
    expect(bash().installed).toBe(true)
  })

  readOnly.it('still installs when the retired block is in a file that cannot be written', () => {
    write('.bashrc', OWN)
    write('.profile', `. ~/.bashrc\n${retiredBlock()}`)
    fs.chmodSync(file('.profile'), 0o444)
    try {
      const r = hooks.installHook('shell-bash')
      expect(r.success, r.message).toBe(true)
    } finally {
      fs.chmodSync(file('.profile'), 0o644)
    }
    expect(count(read('.bashrc'), 'shell-bash-hook.sh')).toBe(1)
    expect(bash().installed).toBe(true)
    expect(bash().retiredLines).toEqual([{ file: file('.profile'), line: 4 }])
  })
})

describe('removal takes the retired line with the current one', () => {
  beforeEach(asPosixHost)

  it('uninstalling bash removes both', () => {
    write('.bashrc', OWN + retiredBlock())
    expect(hooks.installHook('shell-bash').success).toBe(true)
    write('.bashrc', read('.bashrc') + retiredBlock())

    const r = hooks.uninstallHook('shell-bash')
    expect(r.success, r.message).toBe(true)
    expect(read('.bashrc')).toBe(OWN)
  })

  it('the uninstaller pass sees a shell whose only line is the retired one', () => {
    write('.bashrc', OWN + retiredBlock())
    expect(hooks.removeInstalledHooks()).toEqual(['shell-bash'])
    expect(read('.bashrc')).toBe(OWN)
  })
})

// --- the shell itself ----------------------------------------------------
//
// The real bash, in the throwaway HOME: it complains about the missing file
// before, and not after. On Windows this is Git Bash by its install path —
// `bash` on PATH there may be the WSL launcher, which has a HOME of its own.

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p))
const realBash = process.platform === 'win32'
  ? { exe: GIT_BASH, describe: GIT_BASH ? describe : describe.skip }
  : { exe: 'bash', describe: requires('bash').describe }

function shellStartupErrors(): string {
  const r = spawnSync(realBash.exe!, ['-i', '-c', 'echo started'], {
    encoding: 'utf8', timeout: 30_000, input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, TERM: 'dumb' }
  })
  expect(r.error, String(r.error)).toBeUndefined()
  expect(r.stdout).toContain('started')
  return r.stderr
}

realBash.describe('a new bash after the line is removed', () => {
  it('stops reporting the missing file at startup', () => {
    write('.bashrc', `${OWN}\n${MARKER}\nsource ~/.redlog/${RETIRED}\n`)
    expect(shellStartupErrors()).toContain(RETIRED)

    expect(hooks.removeRetiredHookLines('shell-bash').success).toBe(true)
    expect(read('.bashrc')).toBe(OWN)
    expect(shellStartupErrors()).not.toContain(RETIRED)
  })
})
