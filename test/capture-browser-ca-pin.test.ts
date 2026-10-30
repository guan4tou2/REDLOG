import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildArgs } from '../src/main/services/browser-launcher'
import { readCaSpki } from '../src/main/services/managed-http-proxy'
import { DEFAULT_BROWSER } from '../src/core/browser-defaults'

// The RedLog capture browser could not open an HTTPS page on Windows: Chrome
// checks the OS trust store, and the managed proxy's CA is not in it until the
// operator adds a root certificate by hand — the longest-lived thing RedLog can
// leave on a machine. Measured on the installed v0.18.4: net::ERR_CERT_AUTHORITY_INVALID
// for https://example.com/, and no flow recorded.
//
// The capture browser now trusts that one CA by its public key
// (--ignore-certificate-errors-spki-list), in RedLog's own profile only.
// Chrome honours the switch only with --user-data-dir, which that profile has.

// Made with openssl; the expected pin is openssl's, not this code's:
//   openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
const FIXTURE = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUQFbX1nnQQXbCZ5hPSSTaOdaDZu0wCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTcmVkbG9nLXNwa2ktZml4dHVyZTAeFw0yNjEwMjgxNjQ2MTVa
Fw0zNjEwMjUxNjQ2MTVaMB4xHDAaBgNVBAMME3JlZGxvZy1zcGtpLWZpeHR1cmUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQQJaY43YA3gX/Pd9eWjY39AYA+TKNN
/QQgPOrXIETJITB8M1p9UHUgfXSUxdUu03u6WVyASt2sXpfjjvSIICRyo1MwUTAd
BgNVHQ4EFgQU9Q3RNM6BmlAyYIgYAE1pBNeKXqMwHwYDVR0jBBgwFoAU9Q3RNM6B
mlAyYIgYAE1pBNeKXqMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiAdDxSUJYT9O0bOUXX9S//pFKuTLm9Y25IR8rzz+deTBwIhAJJLJk2cTW2+lyoi
0QYfiXVrQvNifNKdDZ6a34UHVAUj
-----END CERTIFICATE-----
`
const PIN = 'wBIT7pskTrVzN1Fv4AN2JzZUg5or2NoZ4DwhkwyVLLY='
const PROFILE = '/tmp/proj/browser-profile'
const flag = `--ignore-certificate-errors-spki-list=${PIN}`

let dir = ''
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spki-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('the capture browser trusts the managed CA by its key', () => {
  it('reads the CA\'s SPKI pin the way Chrome wants it', () => {
    const ca = path.join(dir, 'ca.pem')
    fs.writeFileSync(ca, FIXTURE)
    expect(readCaSpki(ca)).toBe(PIN)
  })

  it('has no pin for a missing or unreadable CA', () => {
    expect(readCaSpki(path.join(dir, 'missing.pem'))).toBeNull()
    const bad = path.join(dir, 'bad.pem')
    fs.writeFileSync(bad, 'not a certificate')
    expect(readCaSpki(bad)).toBeNull()
  })

  it('pins that one CA in RedLog\'s own profile, and turns no certificate check off', () => {
    const args = buildArgs(DEFAULT_BROWSER, PROFILE, { trustSpki: PIN })
    expect(args).toContain(flag)
    expect(args).not.toContain('--ignore-certificate-errors')
  })

  it('pins nothing in the operator\'s own profile, or without a pin', () => {
    expect(buildArgs({ ...DEFAULT_BROWSER, isolateProfile: false }, PROFILE, { trustSpki: PIN })).not.toContain(flag)
    expect(buildArgs(DEFAULT_BROWSER, PROFILE).some((a) => a.startsWith('--ignore-certificate-errors'))).toBe(false)
  })
})
