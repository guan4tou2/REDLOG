import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { EventEmitter } from 'events'
import * as cp from 'child_process'

// A fake `wsl.exe`. Real enumeration costs ~2 s per call and needs WSL
// installed, which would make this suite slow, machine-dependent, and — since
// vitest runs files in parallel — slow enough to starve the other workers.
// The canned output is the shape the parser actually has to handle: UTF-16LE
// with the NUL bytes wsl.exe emits.
const calls: string[][] = []

function fakeChild(stdout: Buffer, status = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = (): void => {}
  setImmediate(() => {
    if (stdout.length) child.stdout.emit('data', stdout)
    child.emit('close', status)
  })
  return child
}

const LIST_OUTPUT = Buffer.from(
  '  NAME      STATE      VERSION\r\n* Ubuntu    Running    2\r\n  kali      Stopped    2\r\n'.split('').join('\x00') + '\x00',
  'binary'
)

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    spawn: vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (args[0] === '-l') return fakeChild(LIST_OUTPUT)
      if (args.includes('echo ok')) return fakeChild(Buffer.from('ok'))
      if (args.some((a) => a.includes('which zsh'))) return fakeChild(Buffer.from(''))
      if (args.some((a) => a.includes('grep -c'))) return fakeChild(Buffer.from('1'))
      return fakeChild(Buffer.alloc(0))
    })
  }
})

const { listWslDistros, getNetworkMode, checkHookStatus, runDiagnostics, invalidateWslCache } =
  await import('../src/core/wsl-manager')

// process.platform is non-writable; swap it in place and restore.
function pretendPlatform(p: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

describe('WSL enumeration never blocks the main thread', () => {
  beforeEach(() => {
    calls.length = 0
    invalidateWslCache()
    ;(cp.spawnSync as unknown as Mock).mockClear()
  })

  it('uses no synchronous spawn at all', async () => {
    const restore = pretendPlatform('win32')
    try {
      await listWslDistros()
      await checkHookStatus('Ubuntu', ['bash'])
      getNetworkMode()

      // The assertion that matters: this module runs in the Electron main
      // process alongside the capture API, so a blocking probe here stalls
      // capture. Measured before the fix — listWslDistros() cost 2102 ms and
      // 2409 ms on two consecutive calls, and stalled a POST /api/events for
      // 2059 ms against a shell hook whose deadline is 2 s.
      expect(cp.spawnSync).not.toHaveBeenCalled()
      expect(calls.length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('parses the UTF-16LE listing and only probes running distros', async () => {
    const restore = pretendPlatform('win32')
    try {
      const distros = await listWslDistros()
      expect(distros.map((d) => d.name)).toEqual(['Ubuntu', 'kali'])
      expect(distros[0]).toMatchObject({ state: 'Running', version: 2, isDefault: true })
      expect(distros[1]).toMatchObject({ state: 'Stopped', isDefault: false })
      // The stopped one must not be woken up: no `-d kali` anywhere.
      expect(calls.some((c) => c.includes('kali'))).toBe(false)
      expect(distros[1].hookStatus).toEqual({ bash: 'no-shell', zsh: 'no-shell' })
    } finally {
      restore()
    }
  })

  it('caches the listing instead of re-enumerating', async () => {
    const restore = pretendPlatform('win32')
    try {
      const t0 = Date.now()
      const first = await listWslDistros(t0)
      const callsAfterFirst = calls.length

      // Same clock reading: inside the TTL, so no further wsl.exe at all.
      const second = await listWslDistros(t0)
      expect(second).toBe(first)
      expect(calls.length).toBe(callsAfterFirst)

      // Past the TTL it re-enumerates.
      const later = await listWslDistros(t0 + 31_000)
      expect(later).not.toBe(first)
      expect(calls.length).toBeGreaterThan(callsAfterFirst)
    } finally {
      restore()
    }
  })

  it('invalidateWslCache() forces the next call to re-enumerate', async () => {
    const restore = pretendPlatform('win32')
    try {
      const t0 = Date.now()
      const first = await listWslDistros(t0)
      invalidateWslCache()
      const second = await listWslDistros(t0)
      expect(second).not.toBe(first)
    } finally {
      restore()
    }
  })

  it('returns its no-op shapes off Windows', async () => {
    const restore = pretendPlatform('darwin')
    try {
      expect(await listWslDistros()).toEqual([])
      expect(getNetworkMode()).toBe('not-configured')
      expect(await checkHookStatus('whatever')).toEqual({ bash: 'no-shell', zsh: 'no-shell' })
      expect((await runDiagnostics('whatever')).checks[0].status).toBe('fail')
      expect(calls.length).toBe(0)
    } finally {
      restore()
    }
  })
})
