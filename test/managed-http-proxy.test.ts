import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  ManagedHttpProxy,
  buildManagedProxyArgs,
  readCaFingerprint
} from '../src/main/services/managed-http-proxy'
import {
  isManagedProxy, followCaptureEndpoint,
  managedProxyUrl, isLoopbackHost, proxyAlreadyOn
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

  // #220: trust is removed by the CA's identity, not by the name "mitmproxy"
  // that other tools' CAs share. The fixture's fingerprints were computed by
  // `openssl x509 -fingerprint`, independently of the code under test.
  it('reads the CA fingerprints from the PEM file', () => {
    expect(readCaFingerprint(join(__dirname, 'fixtures', 'test-ca-cert.pem'))).toEqual({
      sha1: '290738EC6DDE00236C0455DDAFF5B1DB3FC9EAD1',
      sha256: '7536FCB49A087CA888846DC8D3D6A1748CF02AC35C30A4E5EC1F68B09B1A96DC'
    })
    expect(readCaFingerprint('/definitely/not/here.pem')).toBeNull()
  })

  it('reports the fingerprint only while the CA file exists', async () => {
    const child = new FakeChild()
    let present = true
    const fp = { sha1: 'AA', sha256: 'BB' }
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never),
      exists: (p: string) => p === '/addon.py' || (p === '/ca.pem' && present),
      fingerprint: () => fp,
      readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080, caPath: '/ca.pem' })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    expect(proxy.status()).toMatchObject({ certReady: true, caFingerprint: fp })
    present = false
    expect(proxy.status().certReady).toBe(false)
    expect(proxy.status().caFingerprint).toBeUndefined()
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

  // #226: start HTTP capture, then launch the capture browser — which starts
  // capture again, because that is how it guarantees the proxy is up before
  // pointing a browser at it — and the operator was told
  // `127.0.0.1:6661 is already in use by python.exe (PID …)`, naming RedLog's
  // own mitmdump as the intruder. The browser never launched.
  describe('proxyAlreadyOn', () => {
    const endpoint = { host: '127.0.0.1', port: 6661 }

    it('recognises our own proxy so the port probe is not asked about us', () => {
      expect(proxyAlreadyOn({ state: 'running', url: 'http://127.0.0.1:6661' }, endpoint)).toBe(true)
      // Loopback spellings are interchangeable, as everywhere else here.
      expect(proxyAlreadyOn({ state: 'running', url: 'http://localhost:6661' }, endpoint)).toBe(true)
    })

    it('counts `starting`, because probing then races the bind we are waiting on', () => {
      expect(proxyAlreadyOn({ state: 'starting', url: 'http://127.0.0.1:6661' }, endpoint)).toBe(true)
    })

    it('does not swallow a port a stranger holds', () => {
      // Nothing of ours is up, so Burp on that port must still be named.
      for (const state of ['stopped', 'failed', 'unavailable']) {
        expect(proxyAlreadyOn({ state, url: null }, endpoint), state).toBe(false)
      }
      // Running, but somewhere else: the operator moved the port in Settings
      // and is asking about the new one, where nothing of ours is yet.
      expect(proxyAlreadyOn({ state: 'running', url: 'http://127.0.0.1:8080' }, endpoint)).toBe(false)
      expect(proxyAlreadyOn({ state: 'running', url: 'http://10.0.0.2:6661' }, endpoint)).toBe(false)
      // Running with no URL says nothing about which endpoint it is on.
      expect(proxyAlreadyOn({ state: 'running', url: null }, endpoint)).toBe(false)
    })
  })
})

// A start that fails before `start()` is reached has to reach the status.
//
// The caller does its own preflight — the addon must exist, a project must be
// open, the port must be free — and each of those returned a failed status
// object that nothing recorded. `status()` reports the snapshot, so every
// surface polling it read `stopped`: not "tried and could not", but "nothing
// has been tried". The operator acts on those differently.
//
// It was survivable while starting capture was a button. It stopped being
// survivable when capture began taking itself up at project open, because a
// port already in use then means an engagement that records no HTTP and never
// says why — observed on a real run, where auto-start returned
// `127.0.0.1:6661 is already in use` and the strip said stopped for the rest
// of the session.
describe('a failure that never reached start()', () => {
  it('puts the reason in the status, not just in the return value', () => {
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(), exists: () => true })
    expect(proxy.status()).toMatchObject({ state: 'stopped' })

    const returned = proxy.noteStartFailure('127.0.0.1:6661 is already in use.')
    expect(returned).toMatchObject({ state: 'failed', url: null })
    expect(proxy.status()).toMatchObject({
      state: 'failed',
      url: null,
      error: '127.0.0.1:6661 is already in use.'
    })
  })

  it('tells the listeners, so a live surface does not wait for its next poll', () => {
    const proxy = new ManagedHttpProxy({ spawn: vi.fn(), exists: () => true })
    const seen: string[] = []
    proxy.onStatusChange((next) => seen.push(next.state))
    proxy.noteStartFailure('no addon')
    expect(seen).toEqual(['failed'])
  })

  it('never overwrites a running proxy', async () => {
    // A preflight that fails while the thing is up is the preflight being
    // wrong, not the proxy stopping — and reporting `failed` over a working
    // capture would be the same lie in the other direction.
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never), exists: () => true, readinessTimeoutMs: 100
    })
    const started = proxy.start({ addonPath: '/addon.py', port: 8080 })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    expect(proxy.status()).toMatchObject({ state: 'running' })

    proxy.noteStartFailure('No project open')
    expect(proxy.status()).toMatchObject({ state: 'running' })
  })

  it('can be cleared by a later successful start', async () => {
    // The failure is a fact about the last attempt, not a latch.
    const child = new FakeChild()
    const proxy = new ManagedHttpProxy({
      spawn: vi.fn(() => child as never), exists: () => true, readinessTimeoutMs: 100
    })
    proxy.noteStartFailure('127.0.0.1:6661 is already in use.')
    expect(proxy.status()).toMatchObject({ state: 'failed' })

    const started = proxy.start({ addonPath: '/addon.py', port: 8081 })
    child.stderr.emit('data', Buffer.from('proxy server listening'))
    await started
    expect(proxy.status()).toMatchObject({ state: 'running' })
    expect(proxy.status().error, 'the old reason outlived the attempt it describes').toBeUndefined()
  })
})
