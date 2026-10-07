import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { installDependency } from '../src/main/services/dependency-installer'
import type { PreflightResult } from '../src/core/runtime-preflight'

// The installer spawns the command the plan cleared and reports the outcome.
// spawn and preflight are injected so no process runs and no PATH is consulted.
function fakeChild(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  return child
}

const preflightWith = (over: Partial<PreflightResult['checks'][number]>): (() => PreflightResult) => () => ({
  platform: 'linux',
  shell: null,
  legacyHooks: [],
  checks: [{ id: 'mitmdump', found: false, neededFor: ['mitmproxy'], ...over }]
})

describe('installDependency', () => {
  it('spawns the installer and resolves success on exit code 0', async () => {
    const child = fakeChild()
    const calls: Array<{ command: string; args: string[] }> = []
    const spawn = ((command: string, args: string[]) => { calls.push({ command, args }); return child }) as never
    const p = installDependency('mitmdump', {
      preflight: preflightWith({ remediation: 'uv tool install mitmproxy' }),
      spawn
    })
    child.stdout.emit('data', 'Installed mitmproxy\n')
    child.emit('close', 0)
    const r = await p
    expect(calls[0]).toEqual({ command: 'uv', args: ['tool', 'install', 'mitmproxy'] })
    expect(r.success).toBe(true)
  })

  it('reports the last output line as the reason on a non-zero exit', async () => {
    const child = fakeChild()
    const spawn = (() => child) as never
    const p = installDependency('mitmdump', {
      preflight: preflightWith({ remediation: 'uv tool install mitmproxy' }),
      spawn
    })
    child.stderr.emit('data', 'error: network unreachable\n')
    child.emit('close', 1)
    const r = await p
    expect(r.success).toBe(false)
    expect(r.message).toBe('error: network unreachable')
  })

  it('does not spawn when the installer prerequisite is missing', async () => {
    let spawned = false
    const spawn = (() => { spawned = true; return fakeChild() }) as never
    const prereq = { command: 'uv', url: 'https://example/uv' }
    const r = await installDependency('mitmdump', {
      preflight: preflightWith({ remediation: 'uv tool install mitmproxy', remediationRequires: prereq }),
      spawn
    })
    expect(spawned).toBe(false)
    expect(r.success).toBe(false)
    expect(r.needsPrereq).toEqual(prereq)
  })

  it('does not spawn a sudo remediation', async () => {
    let spawned = false
    const spawn = (() => { spawned = true; return fakeChild() }) as never
    const r = await installDependency('python3', {
      preflight: () => ({
        platform: 'linux', shell: null, legacyHooks: [],
        checks: [{ id: 'python3', found: false, neededFor: [], remediation: 'sudo apt install python3' }]
      }),
      spawn
    })
    expect(spawned).toBe(false)
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/terminal/)
  })

  it('surfaces ENOENT as a not-installed message', async () => {
    const child = fakeChild()
    const spawn = (() => child) as never
    const p = installDependency('mitmdump', {
      preflight: preflightWith({ remediation: 'uv tool install mitmproxy' }),
      spawn
    })
    const err = new Error('spawn uv ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    child.emit('error', err)
    const r = await p
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/not installed or not on PATH/)
  })

  it('reports already-installed without spawning', async () => {
    let spawned = false
    const spawn = (() => { spawned = true; return fakeChild() }) as never
    const r = await installDependency('mitmdump', { preflight: preflightWith({ found: true }), spawn })
    expect(spawned).toBe(false)
    expect(r.success).toBe(true)
  })
})
