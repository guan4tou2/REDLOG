import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// `commandExists` spawned `which` / `where` once per probed command. On a
// Windows GitHub runner each `where` is a process start plus a Defender scan;
// the first detectHooks() probes ~20 commands, so it ran past 30 s and
// plugins.test's starter-pack test timed out on three separate PRs. The same
// synchronous probe runs on the main thread from capture health. Looking the
// command up on PATH directly answers the same question without a process.

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cmd-lookup-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const touch = (name: string, mode = 0o755): void => {
  fs.writeFileSync(path.join(dir, name), '')
  fs.chmodSync(path.join(dir, name), mode)
}

describe('isOnPath', async () => {
  const { isOnPath } = await import('../src/core/command-lookup')

  it('finds an executable in a PATH directory (POSIX)', () => {
    touch('mitmdump')
    expect(isOnPath('mitmdump', { platform: 'linux', delimiter: path.delimiter, env: { PATH: `/nonexistent${path.delimiter}${dir}` } })).toBe(true)
    expect(isOnPath('nmap', { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
  })

  it('ignores a file without the execute bit, and directories (POSIX)', () => {
    if (process.platform === 'win32') return
    touch('notes', 0o644)
    fs.mkdirSync(path.join(dir, 'folder'))
    expect(isOnPath('notes', { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
    expect(isOnPath('folder', { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
  })

  it('expands PATHEXT on Windows, reading Path as well as PATH', () => {
    touch('wsl.EXE')
    const env = { Path: dir, PATHEXT: '.COM;.EXE;.BAT' }
    expect(isOnPath('wsl', { platform: 'win32', env, delimiter: path.delimiter })).toBe(true)
    // Case-insensitive matching is the filesystem's on Windows; spell the
    // extension as the file does so the test holds on a case-sensitive CI disk.
    expect(isOnPath('wsl.EXE', { platform: 'win32', env, delimiter: path.delimiter })).toBe(true)
    expect(isOnPath('bash', { platform: 'win32', env, delimiter: path.delimiter })).toBe(false)
  })

  // #252 / #259. A Microsoft Store pwsh / python3 on PATH is an App Execution
  // Alias: a reparse point that only the AppX layer resolves. A plain stat gets
  // EACCES, but lstat succeeds (isSymbolicLink, not isFile) and the command runs.
  // EACCES here means "exists, I cannot look" — not "absent".
  describe('App Execution Alias on Windows', () => {
    const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
    const aliasDir = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps'
    const env = { Path: aliasDir, PATHEXT: '.COM;.EXE;.BAT' }
    const isAlias = (p: unknown): boolean => /[\\/](pwsh|python3)\.exe$/i.test(String(p))

    beforeEach(() => {
      vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
        throw errno(isAlias(p) ? 'EACCES' : 'ENOENT')
      }) as unknown as typeof fs.statSync)
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike) => {
        if (!isAlias(p)) throw errno('ENOENT')
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
      }) as unknown as typeof fs.lstatSync)
    })
    afterEach(() => vi.restoreAllMocks())

    it('counts an alias whose stat throws EACCES as present', () => {
      expect(isOnPath('pwsh', { platform: 'win32', env, delimiter: ';' })).toBe(true)
      expect(isOnPath('python3', { platform: 'win32', env, delimiter: ';' })).toBe(true)
    })

    it('still reports a command that is not there as absent (ENOENT is not EACCES)', () => {
      expect(isOnPath('nmap', { platform: 'win32', env, delimiter: ';' })).toBe(false)
    })

    it('does not apply the EACCES leniency off Windows', () => {
      expect(isOnPath('pwsh', { platform: 'linux', env: { PATH: aliasDir }, delimiter: ':' })).toBe(false)
    })
  })

  it('never treats a name with a path or shell syntax as a lookup', () => {
    touch('nmap')
    expect(isOnPath(`${dir}/nmap`, { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
    expect(isOnPath('nmap; curl x', { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
    expect(isOnPath('', { platform: 'linux', delimiter: path.delimiter, env: { PATH: dir } })).toBe(false)
  })

  it('hooks-manager no longer spawns which/where to probe', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/hooks-manager.ts'), 'utf8')
    expect(src).not.toMatch(/'where'|'which'/)
  })
})
