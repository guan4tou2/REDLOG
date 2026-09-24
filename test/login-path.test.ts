import { describe, it, expect } from 'vitest'
import { _mergePath, _resolveLoginShellPath, _runShell, applyLoginPath } from '../src/main/login-path'

const all = (): boolean => true

describe('_mergePath', () => {
  it('keeps the existing PATH first, then shell entries, then candidates', () => {
    expect(_mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ['/home/op/.local/bin'], all))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin:/home/op/.local/bin')
  })

  it('de-duplicates across all three sources, first occurrence wins', () => {
    expect(_mergePath('/a:/b:/a', '/b:/c', ['/c', '/a', '/d'], all)).toBe('/a:/b:/c:/d')
  })

  it('skips candidate directories that do not exist', () => {
    const exists = (d: string): boolean => d !== '/missing'
    expect(_mergePath('/usr/bin', null, ['/missing', '/present'], exists)).toBe('/usr/bin:/present')
  })

  it('never removes an existing entry, even one that does not exist on disk', () => {
    expect(_mergePath('/gone:/usr/bin', '/usr/bin', [], () => false)).toBe('/gone:/usr/bin')
  })

  it('leaves PATH unchanged when the shell failed and no candidate exists', () => {
    expect(_mergePath('/usr/bin:/bin', null, ['/opt/homebrew/bin'], () => false)).toBe('/usr/bin:/bin')
  })

  it('drops empty segments', () => {
    expect(_mergePath('/usr/bin::', ':/x:', [], all)).toBe('/usr/bin:/x')
  })
})

describe('_resolveLoginShellPath', () => {
  it('reads PATH from between the markers, ignoring rc-file noise', async () => {
    const run = async (_shell: string, args: string[]): Promise<string | null> => {
      const script = args[args.length - 1]
      const start = /echo (\S+);/.exec(script)![1]
      const end = /; echo (\S+)$/.exec(script)![1]
      return `motd noise\n${start}\n/opt/homebrew/bin:/usr/bin\n${end}\ntrailing noise`
    }
    expect(await _resolveLoginShellPath('/bin/zsh', { run, timeoutMs: 1000 })).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('returns null when the markers are missing', async () => {
    expect(await _resolveLoginShellPath('/bin/zsh', { run: async () => 'no markers', timeoutMs: 1000 })).toBeNull()
  })

  it('returns null when the shell call throws', async () => {
    expect(await _resolveLoginShellPath('/bin/zsh', { run: async () => { throw new Error('boom') }, timeoutMs: 1000 })).toBeNull()
  })

  it('returns null for a relative or missing shell without running anything', async () => {
    let ran = false
    const run = async (): Promise<string | null> => { ran = true; return '' }
    expect(await _resolveLoginShellPath('zsh', { run, timeoutMs: 1000 })).toBeNull()
    expect(await _resolveLoginShellPath(undefined, { run, timeoutMs: 1000 })).toBeNull()
    expect(ran).toBe(false)
  })

  it('times out on a shell that never answers', async () => {
    const started = Date.now()
    const never = (): Promise<string | null> => new Promise(() => {})
    expect(await _resolveLoginShellPath('/bin/zsh', { run: never, timeoutMs: 100 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('_runShell', () => {
  it.skipIf(process.platform === 'win32')('kills a real shell that outlives the timeout and returns null', async () => {
    const started = Date.now()
    expect(await _runShell('/bin/sh', ['-c', 'sleep 5; echo late'], 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it.skipIf(process.platform === 'win32')('returns stdout of a shell that exits in time', async () => {
    expect(await _runShell('/bin/sh', ['-c', 'echo hi'], 2000)).toBe('hi\n')
  })
})

describe('applyLoginPath', () => {
  it('is a no-op on win32', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' }
    let ran = false
    const changed = await applyLoginPath({
      platform: 'win32', env, run: async () => { ran = true; return null }, exists: all, home: 'C:\\Users\\op'
    })
    expect(changed).toBe(false)
    expect(env.PATH).toBe('C:\\Windows')
    expect(ran).toBe(false)
  })

  it('leaves PATH unchanged when the shell times out and no candidate exists', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }
    const changed = await applyLoginPath({
      platform: 'darwin', env, run: () => new Promise(() => {}), timeoutMs: 50, exists: () => false, home: '/Users/op'
    })
    expect(changed).toBe(false)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  it('appends the login shell PATH and existing well-known dirs', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }
    const run = async (_s: string, args: string[]): Promise<string | null> => {
      const script = args[args.length - 1]
      const start = /echo (\S+);/.exec(script)![1]
      const end = /; echo (\S+)$/.exec(script)![1]
      return `${start}\n/opt/homebrew/bin:/usr/bin\n${end}\n`
    }
    const changed = await applyLoginPath({
      platform: 'darwin', env, run, exists: (d) => d === '/Users/op/.local/bin', home: '/Users/op'
    })
    expect(changed).toBe(true)
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/op/.local/bin')
  })
})
