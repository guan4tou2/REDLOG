import { describe, it, expect } from 'vitest'
import { detectPivot } from '../src/core/pivot-detector'
import { extractTarget } from '../src/core/target-extractor'

describe('detectPivot', () => {
  it('ligolo-ng agent connect', () => {
    const p = detectPivot('./agent -connect 10.0.0.5:11601 -ignore-cert')
    expect(p?.tool).toBe('ligolo-ng')
    expect(p?.subtype).toBe('agent_connect')
    expect(p?.via).toBe('10.0.0.5')
  })

  it('chisel reverse socks', () => {
    const p = detectPivot('chisel client https://vps.example.com:8443 R:socks')
    expect(p?.tool).toBe('chisel')
    expect(p?.subtype).toBe('socks_up')
    expect(p?.via).toBe('vps.example.com')
  })

  it('ssh dynamic socks proxy', () => {
    const p = detectPivot('ssh -D 1080 -N user@jump.corp')
    expect(p?.tool).toBe('ssh')
    expect(p?.subtype).toBe('socks_up')
    expect(p?.socksPort).toBe(1080)
    expect(p?.via).toBe('jump.corp')
  })

  it('ssh local port forward', () => {
    const p = detectPivot('ssh -L 8080:10.0.0.9:80 user@jump.corp')
    expect(p?.tool).toBe('ssh')
    expect(p?.subtype).toBe('port_forward')
    expect(p?.forward).toBe('8080:10.0.0.9:80')
  })

  it('sshuttle route add captures the CIDR', () => {
    const p = detectPivot('sshuttle -r admin@jump.corp 10.10.0.0/16')
    expect(p?.tool).toBe('sshuttle')
    expect(p?.route).toBe('10.10.0.0/16')
    expect(p?.via).toBe('jump.corp')
  })

  it('proxychains marks the downstream target', () => {
    const p = detectPivot('proxychains4 nmap -sT -Pn 10.10.10.5')
    expect(p?.tool).toBe('proxychains')
    expect(p?.subtype).toBe('proxied')
    expect(p?.via).toBe('10.10.10.5')
  })

  it('non-pivot command returns null', () => {
    expect(detectPivot('ls -la')).toBeNull()
    expect(detectPivot('nmap -sV example.com')).toBeNull()
    // `ssh -V`, `ssh -Q cipher` have no hostname → still null.
    expect(detectPivot('ssh -V')).toBeNull()
    expect(detectPivot('ssh -Q cipher')).toBeNull()
  })

  it('interactive ssh into a remote host is recorded as a pivot', () => {
    // Reason: operator jumped to a remote box; every command that follows
    // is running there, and the timeline needs to show that attention
    // moved. Was returning null before v0.6.60.
    const p = detectPivot('ssh user@vps.example.com')
    expect(p?.tool).toBe('ssh')
    expect(p?.subtype).toBe('interactive')
    expect(p?.via).toBe('vps.example.com')

    const p2 = detectPivot('ssh user@host')
    expect(p2?.tool).toBe('ssh')
    expect(p2?.via).toBe('host')
  })
})

describe('target extractor knows pivot tools', () => {
  it('catalogs the downstream host behind proxychains', () => {
    expect(extractTarget('proxychains4 nmap -sT 10.10.10.5')).toBe('10.10.10.5')
  })
  it('catalogs the sshuttle jump host', () => {
    expect(extractTarget('sshuttle -r admin@jump.corp 10.10.0.0/16')).toBe('jump.corp')
  })
})
