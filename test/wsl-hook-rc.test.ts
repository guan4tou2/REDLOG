import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as cp from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The rc line a WSL distro gets is `source "<absolute path to the bundled
// hook>"`. Status and install used to ask only whether the rc mentioned
// `shell-bash-hook` at all, so a line left pointing at a build that has since
// moved — another install location, a dev checkout — read as installed, and
// 驗證／修復 answered "already installed" without touching it.
//
// Every `wsl.exe -d <distro> -- /bin/bash -c …` here runs in a real bash
// against a temporary HOME, so what is asserted is what the rc file ends up
// holding. On Windows that bash must be Git Bash: `bash` on PATH can be the WSL
// launcher, which would edit a real distro's rc.
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash'
const haveBash = fs.existsSync(BASH)

let home = ''
const wslCalls: string[][] = []

// `wsl.exe -l -q` answers in UTF-16LE, one distro name per line.
function fakeListing(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (): void => {} })
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('Ubuntu\r\n', 'utf16le'))
    child.emit('close', 0)
  })
  return child
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts?: cp.SpawnOptions) => {
      if (cmd !== 'wsl.exe') return actual.spawn(cmd, args, opts ?? {})
      wslCalls.push(args)
      if (args[0] === '-l') return fakeListing()
      const [, ...rest] = args.slice(args.indexOf('-e') + 1)
      return actual.spawn(BASH, rest, { ...opts, env: { ...process.env, HOME: home } })
    })
  }
})

const { installHook, checkHookStatus, invalidateWslCache, windowsPathToWsl, removeWslHooks } = await import('../src/core/wsl-manager')

function pretendPlatform(p: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

const current = windowsPathToWsl(path.resolve(__dirname, '../hooks/shell-bash-hook.sh'))
const elsewhere = '/mnt/c/Users/someone/AppData/Local/Programs/OldRedLog/resources/hooks/shell-bash-hook.sh'
const rc = (): string => path.join(home, '.bashrc')
const sourceLines = (): string[] => fs.readFileSync(rc(), 'utf8').split('\n').filter((l) => l.includes('shell-bash-hook'))

describe.skipIf(!haveBash)('a WSL rc line that points at another build', () => {
  let restore: () => void
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-wsl-rc-'))
    wslCalls.length = 0
    invalidateWslCache()
    restore = pretendPlatform('win32')
  })
  afterEach(() => {
    restore()
    fs.rmSync(home, { recursive: true, force: true })
    // The scripts take their rc, path and shell as $1–$3. Behind `--` the
    // distro's default shell expands those to nothing before bash runs, which
    // this fake cannot reproduce, so pin the flag that avoids it.
    for (const args of wslCalls.filter((a) => a[0] === '-d')) expect(args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '-e'])
  })

  it('is not reported as installed', async () => {
    fs.writeFileSync(rc(), `alias ll='ls -l'\n\n# RedLog WSL hook\nsource "${elsewhere}"\n`)
    expect((await checkHookStatus('Ubuntu', ['bash'])).bash).toBe('not-installed')
  })

  it('is replaced by install, leaving one line for the current build and the rest of the rc alone', async () => {
    fs.writeFileSync(rc(), `alias ll='ls -l'\n\n# RedLog WSL hook\nsource "${elsewhere}"\nexport EDITOR=vim\n`)
    const r = await installHook('Ubuntu', 'bash')
    expect(r.success).toBe(true)
    expect(sourceLines()).toEqual([`source "${current}"`])
    const text = fs.readFileSync(rc(), 'utf8')
    expect(text).toContain("alias ll='ls -l'")
    expect(text).toContain('export EDITOR=vim')
    expect(text.match(/# RedLog WSL hook/g)).toHaveLength(1)
    expect((await checkHookStatus('Ubuntu', ['bash'])).bash).toBe('installed')
  })

  it('leaves a current line exactly as it is', async () => {
    const before = `# RedLog WSL hook\nsource "${current}"\n`
    fs.writeFileSync(rc(), before)
    expect((await installHook('Ubuntu', 'bash')).message).toMatch(/already installed/)
    expect(fs.readFileSync(rc(), 'utf8')).toBe(before)
    expect((await checkHookStatus('Ubuntu', ['bash'])).bash).toBe('installed')
  })

  it('installs into a distro with no rc yet', async () => {
    expect((await installHook('Ubuntu', 'bash')).success).toBe(true)
    expect(sourceLines()).toEqual([`source "${current}"`])
  })
})

// Uninstall runs the installed app with --remove-hooks, which takes this
// build's line out of every distro. A line for another build is not this
// uninstall's to remove.
describe.skipIf(!haveBash)('removing this build\'s WSL hook on uninstall', () => {
  let restore: () => void
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-wsl-rc-'))
    wslCalls.length = 0
    invalidateWslCache()
    restore = pretendPlatform('win32')
  })
  afterEach(() => {
    restore()
    fs.rmSync(home, { recursive: true, force: true })
    for (const args of wslCalls.filter((a) => a[0] === '-d')) expect(args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '-e'])
  })

  it('takes out the line and its marker and keeps the rest of the rc', async () => {
    fs.writeFileSync(rc(), "alias ll='ls -l'\nexport EDITOR=vim\n")
    expect((await installHook('Ubuntu', 'bash')).success).toBe(true)

    expect(await removeWslHooks()).toEqual(['Ubuntu: ~/.bashrc'])
    const text = fs.readFileSync(rc(), 'utf8')
    expect(text).toContain("alias ll='ls -l'")
    expect(text).toContain('export EDITOR=vim')
    expect(text).not.toContain('shell-bash-hook')
    expect(text).not.toContain('RedLog WSL hook')
  })

  it('removes an rc that held nothing but the hook', async () => {
    expect((await installHook('Ubuntu', 'bash')).success).toBe(true)
    expect(await removeWslHooks()).toEqual(['Ubuntu: ~/.bashrc'])
    expect(fs.existsSync(rc())).toBe(false)
  })

  it('leaves a line for another build, and an rc with no hook, untouched', async () => {
    const before = `alias ll='ls -l'\n\n# RedLog WSL hook\nsource "${elsewhere}"\n`
    fs.writeFileSync(rc(), before)
    expect(await removeWslHooks()).toEqual([])
    expect(fs.readFileSync(rc(), 'utf8')).toBe(before)
  })
})
