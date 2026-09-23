import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ManagedHttpProxy,
  buildManagedProxyArgs,
  isManagedLoopbackProxy
} from '../src/main/services/managed-http-proxy'

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  killed = false
  stdout = new FakeStream()
  stderr = new FakeStream()
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }
}

describe('managed HTTP proxy', () => {
  it('builds a loopback-only regular proxy using the shipped addon', () => {
    expect(buildManagedProxyArgs('/app/hooks/mitmproxy-addon.py', 8080)).toEqual([
      '--listen-host', '127.0.0.1', '--listen-port', '8080',
      '--set', 'block_global=false', '-s', '/app/hooks/mitmproxy-addon.py'
    ])
  })

  it('only claims ownership of matching loopback proxy URLs', () => {
    expect(isManagedLoopbackProxy('http://127.0.0.1:8080', 8080)).toBe(true)
    expect(isManagedLoopbackProxy('http://localhost:8080', 8080)).toBe(true)
    expect(isManagedLoopbackProxy('http://127.0.0.1:9090', 8080)).toBe(false)
    expect(isManagedLoopbackProxy('http://10.0.0.2:8080', 8080)).toBe(false)
    expect(isManagedLoopbackProxy('socks5://127.0.0.1:8080', 8080)).toBe(false)
  })

  it('recognises any loopback HTTP port as managed while leaving remote proxies external', async () => {
    const { isLoopbackHttpProxy } = await import('../src/main/services/managed-http-proxy')
    expect(isLoopbackHttpProxy('http://127.0.0.1:9090')).toBe(true)
    expect(isLoopbackHttpProxy('http://localhost:3128')).toBe(true)
    expect(isLoopbackHttpProxy('http://10.0.0.2:8080')).toBe(false)
  })

  it('reports CA readiness without changing the trust store', async () => {
    const child = new FakeChild()
    const exists = vi.fn((p: string) => p === '/addon.py' || p === '/ca.pem')
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(() => child as never), exists, readinessTimeoutMs: 100 })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080, caPath: '/ca.pem' })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    expect(proxy.status()).toMatchObject({ caPath: '/ca.pem', certReady: true })
  })

  it('notifies listeners when a running proxy exits unexpectedly', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(() => child as never), exists: () => true, readinessTimeoutMs: 100 })
    const transitions: string[] = []
    proxy.onStatusChange((next, previous) => transitions.push(`${previous.state}->${next.state}`))
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    child.exitCode = 3
    child.emit('exit', 3, null)
    expect(transitions).toContain('running->failed')
  })

  it('reaches running only after mitmdump announces a listener', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never),
      exists: () => true,
      readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    expect(proxy.status().state).toBe('starting')
    child.stderr.emit('data', Buffer.from('HTTP(S) proxy server listening at 127.0.0.1:8080'))
    await expect(started).resolves.toMatchObject({ state: 'running', pid: 4242 })
  })

  it('reports an unavailable binary and does not pretend to run', async () => {
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => { throw Object.assign(new Error('spawn mitmdump ENOENT'), { code: 'ENOENT' }) }),
      exists: () => true,
      readinessTimeoutMs: 10
    })
    await expect(proxy.start({ addonPath: '/addon.py', port: 8080 })).resolves.toMatchObject({
      state: 'unavailable'
    })
    expect(proxy.status().error).toMatch(/mitmdump/i)
  })

  it('retains an early-exit reason and stops only its owned child', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never),
      exists: () => true,
      readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    child.stderr.emit('data', Buffer.from('Address already in use'))
    child.exitCode = 1
    child.emit('exit', 1, null)
    await expect(started).resolves.toMatchObject({ state: 'failed' })
    expect(proxy.status().error).toMatch(/Address already in use/)
    expect(proxy.stop().state).toBe('stopped')
    expect(child.killed).toBe(false)
  })

  it('kills its live child on stop', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never),
      exists: () => true,
      readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    expect(proxy.stop()).toMatchObject({ state: 'stopped' })
    expect(child.killed).toBe(true)
  })

  it('does not turn a cancelled startup into a failed state', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never), exists: () => true, readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    expect(proxy.stop().state).toBe('stopped')
    await expect(started).resolves.toMatchObject({ state: 'stopped' })
    expect(proxy.status().state).toBe('stopped')
  })

  it('drops readiness when the running child exits', async () => {
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never), exists: () => true, readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    child.stderr.emit('data', Buffer.from('fatal runtime error'))
    child.exitCode = 2
    child.emit('exit', 2, null)
    expect(proxy.status()).toMatchObject({ state: 'failed', url: null })
    expect(proxy.status().error).toMatch(/fatal runtime error/)
  })
})
