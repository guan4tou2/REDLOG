import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ManagedHttpProxy,
  buildManagedProxyArgs
} from '../src/main/services/managed-http-proxy'
import {
  isManagedProxy, followCaptureEndpoint,
  managedProxyUrl, isLoopbackHost
} from '../src/core/managed-proxy-url'

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
    expect(isManagedProxy('http://127.0.0.1:8080', { host: '127.0.0.1', port: 8080 })).toBe(true)
    expect(isManagedProxy('http://localhost:8080', { host: '127.0.0.1', port: 8080 })).toBe(true)
    expect(isManagedProxy('http://127.0.0.1:9090', { host: '127.0.0.1', port: 8080 })).toBe(false)
    expect(isManagedProxy('http://10.0.0.2:8080', { host: '127.0.0.1', port: 8080 })).toBe(false)
    expect(isManagedProxy('socks5://127.0.0.1:8080', { host: '127.0.0.1', port: 8080 })).toBe(false)
  })

  // Spec 019 FR-007. browser:launch swaps the browser's proxy for the managed one
  // only under this rule; Burp on 127.0.0.1:8081 is the operator's. It used a
  // separate any-loopback-port rule, which claimed Burp too.
  it('leaves a loopback proxy on another port to the operator', () => {
    expect(isManagedProxy('http://127.0.0.1:8081', { host: '127.0.0.1', port: 8080 })).toBe(false)
  })

  // FR-008: moving the capture port moves a browser proxy that pointed at it.
  it('moves only a browser proxy that pointed at the old capture port', () => {
    expect(followCaptureEndpoint('http://127.0.0.1:8080', { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 9090 })).toBe('http://127.0.0.1:9090')
    expect(followCaptureEndpoint('http://localhost:8080', { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 9090 })).toBe('http://localhost:9090')
    expect(followCaptureEndpoint('http://127.0.0.1:8081', { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 9090 })).toBe('http://127.0.0.1:8081')
    expect(followCaptureEndpoint('http://10.0.0.2:8080', { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 9090 })).toBe('http://10.0.0.2:8080')
    expect(followCaptureEndpoint('', { host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 9090 })).toBe('')
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

// The capture endpoint is host AND port. It was port alone, with 127.0.0.1
// written into the mitmdump args, the advertised URL and the matcher, so the
// proxy could only ever be reached from the machine RedLog runs on — which
// rules out a victim VM, a phone, a container, and (on Windows) a NAT'd WSL
// distro, while RedLog offers WSL shells in its own picker.
describe('the capture endpoint is host and port', () => {
  it('binds the host it was given, and advertises that address', async () => {
    expect(buildManagedProxyArgs('/a.py', 9090, '0.0.0.0')).toEqual([
      '--listen-host', '0.0.0.0', '--listen-port', '9090',
      '--set', 'block_global=false', '-s', '/a.py'
    ])
    expect(managedProxyUrl({ host: '10.0.0.2', port: 9090 })).toBe('http://10.0.0.2:9090')
    // A bare IPv6 address needs brackets to be a URL at all.
    expect(managedProxyUrl({ host: '::1', port: 9090 })).toBe('http://[::1]:9090')
  })

  it('still defaults to loopback when no host is given', () => {
    expect(buildManagedProxyArgs('/a.py', 9090)).toContain('127.0.0.1')
  })

  it('knows its own proxy at a non-loopback address', () => {
    const lan = { host: '10.0.0.2', port: 9090 }
    expect(isManagedProxy('http://10.0.0.2:9090', lan)).toBe(true)
    expect(isManagedProxy('http://127.0.0.1:9090', lan)).toBe(false)
    // Loopback spellings stay interchangeable.
    expect(isManagedProxy('http://localhost:9090', { host: '127.0.0.1', port: 9090 })).toBe(true)
  })

  it('moves the browser proxy when the host moves, and leaves the operator\'s own alone', () => {
    const from = { host: '127.0.0.1', port: 9090 }
    const to = { host: '10.0.0.2', port: 9090 }
    expect(followCaptureEndpoint('http://127.0.0.1:9090', from, to)).toBe('http://10.0.0.2:9090')
    expect(followCaptureEndpoint('http://localhost:9090', from, to)).toBe('http://10.0.0.2:9090')
    // Someone else's proxy — Burp, a remote one — is used as typed.
    expect(followCaptureEndpoint('http://127.0.0.1:8080', from, to)).toBe('http://127.0.0.1:8080')
  })

  it('tells loopback from an address the engagement network can reach', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', ' LOCALHOST ']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
    for (const h of ['0.0.0.0', '10.0.0.2', '192.168.1.5', 'redlog.local']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })
})
