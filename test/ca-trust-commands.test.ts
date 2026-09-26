// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { caTrustCommand, caUntrustCommand, linuxCaFile, type TrustOs } from '../src/renderer/src/components/HttpCaptureStep'

// The CA is the whole difference between "RedLog's own browser is captured"
// and "HTTPS from anything on this machine is captured". The launched browser
// is told to ignore certificate errors; every other tool — curl, a scanner,
// an implant — refuses the connection, and an HTTP-only timeline reads as
// "the target used no TLS".
//
// Trusting a root CA is a change to the machine, so RedLog shows the command
// rather than running it, and shows the command that undoes it beside it: a
// root certificate left behind after an engagement is the longest-lived thing
// this product can leave on a machine, and the one nobody remembers.
//
// #220: the removal names this CA by its fingerprint. Every mitmproxy install
// calls its CA "mitmproxy", so removing by that name also removed a CA some
// other tool had installed for its own use.
//
// The OS is passed in rather than re-derived: platform detection lives in
// lib/platform.ts and a guard in shortcuts.test.ts keeps it there.

const FP = { sha1: '290738EC6DDE00236C0455DDAFF5B1DB3FC9EAD1', sha256: '7536FCB4' }

describe('the CA commands', () => {
  it('adds and removes on Windows, removing by thumbprint', () => {
    expect(caTrustCommand('C:\\ca.pem', FP, 'win32')).toContain('certutil -addstore')
    expect(caUntrustCommand('C:\\ca.pem', FP, 'win32')).toBe(`certutil -delstore -user Root ${FP.sha1}`)
  })

  it('adds and removes on macOS, removing by SHA-1 hash and this file’s trust setting', () => {
    expect(caTrustCommand('/ca.pem', FP, 'darwin')).toContain('add-trusted-cert')
    const untrust = caUntrustCommand('/ca.pem', FP, 'darwin')
    expect(untrust).toContain(`delete-certificate -Z ${FP.sha1}`)
    expect(untrust).toContain('remove-trusted-cert -d "/ca.pem"')
  })

  it('adds and removes on Linux under a RedLog-specific file name', () => {
    const file = linuxCaFile(FP)
    expect(file).toBe('/usr/local/share/ca-certificates/redlog-mitmproxy-290738ec6dde0023.crt')
    expect(caTrustCommand('/ca.pem', FP, 'linux')).toBe(`sudo cp "/ca.pem" ${file} && sudo update-ca-certificates`)
    expect(caUntrustCommand('/ca.pem', FP, 'linux')).toBe(`sudo rm -f ${file} && sudo update-ca-certificates --fresh`)
  })

  it('never removes by the shared name "mitmproxy"', () => {
    for (const p of ['win32', 'darwin', 'linux'] as TrustOs[]) {
      const untrust = caUntrustCommand('/ca.pem', FP, p)
      expect(untrust, p).not.toMatch(/Root mitmproxy\b|-c mitmproxy\b|ca-certificates\/mitmproxy\.crt/)
    }
  })

  it('quotes the certificate path, which can contain spaces', () => {
    expect(caTrustCommand('C:\\Users\\a b\\.mitmproxy\\ca.pem', FP, 'win32')).toContain('"C:\\Users\\a b\\.mitmproxy\\ca.pem"')
  })

  // Every platform must offer both halves; an install with no uninstall is
  // the footprint this product exists to avoid leaving. Without a fingerprint
  // there is no identity-safe removal, so neither half is offered.
  it('offers trust only together with its removal', () => {
    for (const p of ['win32', 'darwin', 'linux'] as TrustOs[]) {
      expect(caTrustCommand('/ca.pem', FP, p).length, p).toBeGreaterThan(0)
      expect(caUntrustCommand('/ca.pem', FP, p).length, p).toBeGreaterThan(0)
      expect(caTrustCommand('/ca.pem', null, p), p).toBe('')
      expect(caUntrustCommand('/ca.pem', null, p), p).toBe('')
    }
  })
})
