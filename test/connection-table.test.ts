import { describe, it, expect } from 'vitest'
import {
  parseSs, parseNetstatBsd, parseNetstatWin,
  diffConns, indexConns, connKey, isCapturable,
  type Connection
} from '../src/core/connection-table'

// docs/DESIGN-core-and-capture.md §2.1. The parsers are where the platform
// quirks live — BSD's `addr.port`, IPv6 zones, the pid column landing in a
// different place per OS — so this is where the real risk is, and it can all
// be tested without a socket.

describe('parsing the Linux ss table', () => {
  it('reads an established outbound TCP connection with its pid', () => {
    const out = 'tcp   0 0 10.0.0.5:52341 10.10.11.24:445 users:(("nc",pid=1234,fd=3))'
    const [c] = parseSs(out)
    expect(c).toMatchObject({
      proto: 'tcp', localAddr: '10.0.0.5', localPort: 52341,
      remoteAddr: '10.10.11.24', remotePort: 445, pid: 1234
    })
  })

  it('handles a pidless row when -p was not honoured', () => {
    const [c] = parseSs('tcp 0 0 10.0.0.5:52341 10.10.11.24:445')
    expect(c.pid).toBeUndefined()
    expect(c.remotePort).toBe(445)
  })

  it('reads IPv6 and strips the interface zone', () => {
    const out = 'tcp 0 0 [fe80::a%eth0]:52341 [2001:db8::1]:443 users:(("ssh",pid=9,fd=3))'
    const [c] = parseSs(out)
    expect(c.proto).toBe('tcp6')
    expect(c.remoteAddr).toBe('2001:db8::1')
    expect(c.localAddr).toBe('fe80::a')
  })

  it('ignores anything that is not tcp/udp', () => {
    expect(parseSs('nl UNCONN 0 0 rtnl:NetworkManager/1234 *')).toEqual([])
  })
})

describe('parsing the macOS netstat table', () => {
  it('reads an established TCP row and its dot-separated port', () => {
    const out = 'tcp4  0  0  10.0.0.5.52341  10.10.11.24.445  ESTABLISHED'
    const [c] = parseNetstatBsd(out)
    expect(c).toMatchObject({
      proto: 'tcp', localAddr: '10.0.0.5', localPort: 52341,
      remoteAddr: '10.10.11.24', remotePort: 445
    })
    expect(c.pid).toBeUndefined()
  })

  it('drops non-established TCP rows', () => {
    expect(parseNetstatBsd('tcp4 0 0 10.0.0.5.52341 10.10.11.24.445 SYN_SENT')).toEqual([])
    expect(parseNetstatBsd('tcp4 0 0 10.0.0.5.8080 *.* LISTEN')).toEqual([])
  })

  it('reads an IPv6 row', () => {
    const [c] = parseNetstatBsd('tcp6 0 0 fe80::a.52341 2001:db8::1.443 ESTABLISHED')
    expect(c.proto).toBe('tcp6')
    expect(c.remoteAddr).toBe('2001:db8::1')
    expect(c.remotePort).toBe(443)
  })
})

describe('parsing the Windows netstat table', () => {
  it('reads an established TCP row with its trailing pid', () => {
    const out = '  TCP    10.0.0.5:52341   10.10.11.24:445   ESTABLISHED   1234'
    const [c] = parseNetstatWin(out)
    expect(c).toMatchObject({
      proto: 'tcp', remoteAddr: '10.10.11.24', remotePort: 445, pid: 1234
    })
  })

  it('drops LISTENING and TIME_WAIT rows', () => {
    expect(parseNetstatWin('  TCP  0.0.0.0:445  0.0.0.0:0  LISTENING  4')).toEqual([])
    expect(parseNetstatWin('  TCP  10.0.0.5:52341  10.10.11.24:445  TIME_WAIT  0')).toEqual([])
  })

  it('reads a bracketed IPv6 row', () => {
    const [c] = parseNetstatWin('  TCP  [fe80::a]:52341  [2001:db8::1]:445  ESTABLISHED  99')
    expect(c.proto).toBe('tcp6')
    expect(c.remoteAddr).toBe('2001:db8::1')
    expect(c.pid).toBe(99)
  })
})

describe('what counts as capturable', () => {
  const self = new Set([6789])
  const c = (remoteAddr: string, remotePort = 445, localAddr = '10.0.0.5'): Connection => ({
    proto: 'tcp', localAddr, localPort: 52341, remoteAddr, remotePort
  })

  it('keeps a real outbound connection to a target', () => {
    expect(isCapturable(c('10.10.11.24'), self)).toBe(true)
  })

  it('drops loopback, so the timeline is not buried in localhost', () => {
    expect(isCapturable(c('127.0.0.1'), self)).toBe(false)
    expect(isCapturable(c('::1'), self)).toBe(false)
  })

  it('drops link-local', () => {
    expect(isCapturable(c('169.254.1.1'), self)).toBe(false)
    expect(isCapturable(c('fe80::1'), self)).toBe(false)
  })

  it('drops RedLog talking to its own API port', () => {
    // Every shell hook POSTs to it; without this the timeline fills with
    // RedLog observing itself.
    expect(isCapturable(c('10.10.11.24', 6789), self)).toBe(false)
  })
})

describe('diffing snapshots into opened and closed', () => {
  const mk = (remotePort: number): Connection => ({
    proto: 'tcp', localAddr: '10.0.0.5', localPort: 50000 + remotePort,
    remoteAddr: '10.10.11.24', remotePort
  })

  it('reports a new connection as opened', () => {
    const prev = indexConns([mk(445)])
    const next = indexConns([mk(445), mk(3389)])
    const { opened, closed } = diffConns(prev, next)
    expect(opened.map((c) => c.remotePort)).toEqual([3389])
    expect(closed).toEqual([])
  })

  it('reports a vanished connection as closed — this carries the duration', () => {
    const prev = indexConns([mk(445), mk(3389)])
    const next = indexConns([mk(445)])
    const { opened, closed } = diffConns(prev, next)
    expect(opened).toEqual([])
    expect(closed.map((c) => c.remotePort)).toEqual([3389])
  })

  it('says nothing about a long-lived connection present in both', () => {
    // A reverse shell open across many polls must be one open + one close, not
    // a row per poll, or the span degenerates into a wall.
    const prev = indexConns([mk(4444)])
    const next = indexConns([mk(4444)])
    const { opened, closed } = diffConns(prev, next)
    expect(opened).toEqual([])
    expect(closed).toEqual([])
  })

  it('treats two beacons to the same host on different local ports as two', () => {
    const a: Connection = { proto: 'tcp', localAddr: '10.0.0.5', localPort: 51000, remoteAddr: '1.2.3.4', remotePort: 443 }
    const b: Connection = { proto: 'tcp', localAddr: '10.0.0.5', localPort: 51001, remoteAddr: '1.2.3.4', remotePort: 443 }
    expect(connKey(a)).not.toBe(connKey(b))
    expect(indexConns([a, b]).size).toBe(2)
  })

  it('keys ignore pid, so a re-attributed connection stays the same one', () => {
    const a: Connection = { proto: 'tcp', localAddr: '10.0.0.5', localPort: 51000, remoteAddr: '1.2.3.4', remotePort: 443, pid: 10 }
    const b: Connection = { ...a, pid: 20 }
    expect(connKey(a)).toBe(connKey(b))
  })
})
