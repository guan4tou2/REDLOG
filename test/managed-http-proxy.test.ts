import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ManagedHttpProxy,
  buildManagedProxyArgs
} from '../src/main/services/managed-http-proxy'
import { isManagedLoopbackProxy, followCapturePort } from '../src/core/managed-proxy-url'

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

  // Spec 019 FR-007. browser:launch swaps the browser's proxy for the managed one
  // only under this rule; Burp on 127.0.0.1:8081 is the operator's. It used a
  // separate any-loopback-port rule, which claimed Burp too.
  it('leaves a loopback proxy on another port to the operator', () => {
    expect(isManagedLoopbackProxy('http://127.0.0.1:8081', 8080)).toBe(false)
  })

  // FR-008: moving the capture port moves a browser proxy that pointed at it.
  it('moves only a browser proxy that pointed at the old capture port', () => {
    expect(followCapturePort('http://127.0.0.1:8080', 8080, 9090)).toBe('http://127.0.0.1:9090')
    expect(followCapturePort('http://localhost:8080', 8080, 9090)).toBe('http://localhost:9090')
    expect(followCapturePort('http://127.0.0.1:8081', 8080, 9090)).toBe('http://127.0.0.1:8081')
    expect(followCapturePort('http://10.0.0.2:8080', 8080, 9090)).toBe('http://10.0.0.2:8080')
    expect(followCapturePort('', 8080, 9090)).toBe('')
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
