import { describe, it, expect, beforeEach } from 'vitest'
import {
  notePortPid, noteCommandPid, resolveByPid, resolveByLocalPort,
  portOfSourceAddr, socketCausesFor, _resetSocketAttribution
} from '../src/core/socket-attribution'

// Socket → pid → command attribution (docs/DESIGN-traffic-attribution.md §2.3).
// Pure module: the join that lets a request cite the command that opened its
// socket, without any DB or capture pipeline.

beforeEach(() => _resetSocketAttribution())

describe('portOfSourceAddr', () => {
  it('pulls the trailing port from ipv4 and bracketed ipv6', () => {
    expect(portOfSourceAddr('127.0.0.1:54321')).toBe(54321)
    expect(portOfSourceAddr('[::1]:8080')).toBe(8080)
  })
  it('is undefined for garbage / no port / out-of-range', () => {
    expect(portOfSourceAddr('127.0.0.1')).toBeUndefined()
    expect(portOfSourceAddr('127.0.0.1:')).toBeUndefined()
    expect(portOfSourceAddr('127.0.0.1:99999')).toBeUndefined()
    expect(portOfSourceAddr(undefined)).toBeUndefined()
  })
})

describe('pid / port resolution', () => {
  it('resolves a connection by its pid', () => {
    noteCommandPid(4242, 'cmd-1')
    expect(resolveByPid(4242)).toBe('cmd-1')
    expect(resolveByPid(9999)).toBeNull()
  })

  it('resolves traffic by local port through the port→pid→command chain', () => {
    noteCommandPid(4242, 'cmd-1')
    notePortPid(54321, 4242)
    expect(resolveByLocalPort(54321)).toBe('cmd-1')
    // Port with a known pid but no command yet → null (not a wrong edge).
    notePortPid(55000, 7777)
    expect(resolveByLocalPort(55000)).toBeNull()
  })

  it('ignores invalid pids and ports rather than making a bad edge', () => {
    noteCommandPid(0, 'x'); noteCommandPid(undefined, 'y')
    expect(resolveByPid(0)).toBeNull()
    notePortPid(0, 1); notePortPid(80, 0)
    expect(resolveByLocalPort(0)).toBeNull()
    expect(resolveByLocalPort(80)).toBeNull()
  })

  it('newest writer wins when a port or pid is reused', () => {
    noteCommandPid(4242, 'cmd-old')
    noteCommandPid(4242, 'cmd-new')
    expect(resolveByPid(4242)).toBe('cmd-new')
  })
})

describe('socketCausesFor', () => {
  it('cites the command for a connection event carrying a pid', () => {
    noteCommandPid(4242, 'cmd-nmap')
    expect(socketCausesFor('scanner', { subtype: 'connection', pid: 4242 })).toEqual(['cmd-nmap'])
  })

  it('cites the command for an HTTP event via its source_addr port', () => {
    noteCommandPid(4242, 'cmd-sqlmap')
    notePortPid(54321, 4242)
    expect(socketCausesFor('scanner', { subtype: 'http_request_start', source_addr: '127.0.0.1:54321' }))
      .toEqual(['cmd-sqlmap'])
  })

  it('prefers an explicit local_port over parsing source_addr', () => {
    noteCommandPid(4242, 'cmd-a'); notePortPid(54321, 4242)
    expect(socketCausesFor('dns', { local_port: 54321 })).toEqual(['cmd-a'])
  })

  it('returns [] for a non-traffic type, and when nothing joins', () => {
    noteCommandPid(4242, 'cmd')
    expect(socketCausesFor('shell', { pid: 4242 })).toEqual([]) // not traffic
    expect(socketCausesFor('scanner', { subtype: 'connection', pid: 1 })).toEqual([]) // unknown pid
    expect(socketCausesFor('scanner', { subtype: 'connection' })).toEqual([]) // macOS: no pid, no port
  })
})
