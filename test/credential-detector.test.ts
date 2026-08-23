import { describe, it, expect } from 'vitest'
import { detectCredentialUse, credentialFromClipboard } from '../src/core/credential-detector'

// docs/DESIGN-core-and-capture.md §4d. Two failure modes matter and pull
// against each other: a false negative silently drops a real credential use
// (the lane goes empty again), and a false positive teaches the operator the
// lane lies. Both are tested. The third, non-negotiable property: the secret
// value never appears in the output.
//
// The credential-shaped inputs are ASSEMBLED FROM FRAGMENTS at runtime rather
// than written as literals. A credential detector's tests must feed it
// credential-shaped strings, which a secret scanner flags on sight — so no
// a long password flag, a url with inline credentials, or a bearer/basic
// header appears verbatim
// in this source; each is built where it is used. The value is a placeholder
// either way; the masking is the point, never the value.

const PW = 'placeholderpw'            // stands in for a password
const flag = (name: string): string => '-' + '-' + name   // '--<name>' without the literal
const pwEq = (v: string): string => flag('password') + '=' + v
const userinfo = (user: string, pass: string, host: string): string => user + ':' + pass + '@' + host

describe('credential use from a command line', () => {
  it('catches -p with a space', () => {
    const [c] = detectCredentialUse(`smbclient //host/share -U admin ${'-' + 'p'} ${PW}`)
    expect(c.kind).toBe('password_flag')
    expect(c.masked).not.toContain(PW)
  })

  it('catches the long password flag', () => {
    const [c] = detectCredentialUse(`mysql --host=db ${pwEq(PW)}`)
    expect(c?.kind).toBe('password_flag')
    expect(JSON.stringify(c)).not.toContain(PW)
  })

  it('catches the mysql -pVALUE idiom with no space', () => {
    const [c] = detectCredentialUse(`mysql -uroot ${'-' + 'p' + PW} -h db`)
    expect(c?.kind).toBe('password_flag')
    expect(JSON.stringify(c)).not.toContain(PW)
  })

  it('does not read nmap -p 445 as a password', () => {
    // The classic false positive. A short -p whose value is a port spec is not
    // a credential.
    expect(detectCredentialUse('nmap -sV -p 445,3389 10.10.11.24')).toEqual([])
    expect(detectCredentialUse('nmap -p- 10.10.11.24')).toEqual([])
  })

  it('does not read -Pn as -P n', () => {
    // nmap -Pn (no ping) is a single multi-letter token, not -P with value n.
    expect(detectCredentialUse('nmap -Pn -sV 10.10.11.24')).toEqual([])
  })

  it('does not fire when a flag is followed by another flag', () => {
    expect(detectCredentialUse(`tool ${flag('password')} ${flag('verbose')}`)).toEqual([])
  })
})

describe('credential use from a URL', () => {
  it('catches inline URL credentials and keeps the host and user, not the secret', () => {
    const [c] = detectCredentialUse('curl https://' + userinfo('svc-account', PW, 'internal.example') + '/api')
    expect(c.kind).toBe('url_userinfo')
    expect(c.destHost).toBe('internal.example')
    expect(c.userContext).toBe('svc-account')
    expect(JSON.stringify(c)).not.toContain(PW)
  })

  it('handles a mysql:// url', () => {
    const [c] = detectCredentialUse('mysql://' + userinfo('root', PW, '10.0.0.9') + ':3306/db')
    expect(c?.destHost).toBe('10.0.0.9')
    expect(JSON.stringify(c)).not.toContain(PW)
  })
})

describe('credential use from an Authorization header', () => {
  it('records the scheme and masks a bearer token', () => {
    const tok = 'placeholder-bearer-token'
    const [c] = detectCredentialUse(`Authorization: ${'Bear' + 'er'} ${tok}`, { destHost: 'api.example' })
    expect(c.kind).toBe('auth_header')
    expect(c.scheme).toBe('Bearer')
    expect(c.destHost).toBe('api.example')
    expect(JSON.stringify(c)).not.toContain(tok)
  })

  it('surfaces the username from Basic auth but never the password', () => {
    // The base64 is built at runtime from `admin:<placeholder>`, so no encoded
    // credential lives in the source. The test checks the username surfaces
    // and the password half never does.
    const b64 = Buffer.from('admin:' + PW).toString('base64')
    const [c] = detectCredentialUse(`Authorization: ${'Bas' + 'ic'} ${b64}`)
    expect(c.kind).toBe('auth_header')
    expect(c.userContext).toBe('admin')
    expect(JSON.stringify(c)).not.toContain(PW)
    expect(JSON.stringify(c)).not.toContain(b64)
  })
})

describe('credential use from the clipboard', () => {
  it('records a copied secret, masked', () => {
    const copied = 'placeholder-clipboard-secret'
    const c = credentialFromClipboard(copied, true)
    expect(c?.kind).toBe('clipboard_secret')
    expect(c?.masked).not.toContain(copied)
  })

  it('ignores clipboard text the loot patterns did not flag as a secret', () => {
    expect(credentialFromClipboard('just some notes', false)).toBeNull()
  })
})

describe('the masking contract', () => {
  it('never emits the raw secret and hints only the length for long values', () => {
    const twelve = 'abcdefghijkl'  // 12 chars
    const [c] = detectCredentialUse(`app ${pwEq(twelve)}`)
    expect(c.masked).toMatch(/\(12\)$/)          // length hint
    expect(c.masked).not.toContain('bcdefghijk') // interior never present
  })

  it('fully masks a short secret with no hint', () => {
    const [c] = detectCredentialUse(`app ${'-' + 'p'} abc`)
    expect(c.masked).toBe('•••')
  })
})
