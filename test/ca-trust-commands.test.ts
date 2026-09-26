// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { caTrustCommand, caUntrustCommand, type TrustOs } from '../src/renderer/src/components/HttpCaptureStep'

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
// The OS is passed in rather than re-derived: platform detection lives in
// lib/platform.ts and a guard in shortcuts.test.ts keeps it there.

describe('the CA commands', () => {
  it('adds and removes on Windows', () => {
    expect(caTrustCommand('C:\ca.pem', 'win32')).toContain('certutil -addstore')
    expect(caUntrustCommand('win32')).toContain('certutil -delstore')
  })

  it('adds and removes on macOS', () => {
    expect(caTrustCommand('/ca.pem', 'darwin')).toContain('add-trusted-cert')
    expect(caUntrustCommand('darwin')).toContain('delete-certificate')
  })

  it('adds and removes on Linux', () => {
    expect(caTrustCommand('/ca.pem', 'linux')).toContain('update-ca-certificates')
    expect(caUntrustCommand('linux')).toContain('update-ca-certificates --fresh')
  })

  it('quotes the certificate path, which can contain spaces', () => {
    expect(caTrustCommand('C:\Users\a b\.mitmproxy\ca.pem', 'win32')).toContain('"C:\Users\a b\.mitmproxy\ca.pem"')
  })

  // Every platform must offer both halves; an install with no uninstall is
  // the footprint this product exists to avoid leaving.
  it('never offers a trust command without its removal', () => {
    for (const p of ['win32', 'darwin', 'linux'] as TrustOs[]) {
      expect(caTrustCommand('/ca.pem', p).length, p).toBeGreaterThan(0)
      expect(caUntrustCommand(p).length, p).toBeGreaterThan(0)
    }
  })
})
