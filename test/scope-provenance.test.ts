// G-D2. `ALERT-ROLES.md` D.3 lists "the scope is correct and legible, sourced
// from the authorisation document rather than typed" as RedLog's *before*
// contribution — but `scopeFile` recorded a path and nothing else. The
// adherence report (G-D1) states "judged against this scope"; without a digest
// that scope is unattributed exactly where the claim needs backing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { readScopeFile, loadScopeFile } from '../src/core/config'

let dir = ''
const write = (name: string, body: string): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scopefile-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readScopeFile — provenance', () => {
  it('digests the file BYTES, so a reviewer can recompute it', () => {
    const body = '10.0.0.0/8\n*.example.com\n'
    const p = write('scope.txt', body)
    const { provenance } = readScopeFile(p, 1_700_000_000_000)
    expect(provenance.digest).toBe(crypto.createHash('sha256').update(body).digest('hex'))
    expect(provenance.bytes).toBe(Buffer.byteLength(body))
    expect(provenance.path).toBe(p)
    expect(provenance.loadedAt).toBe(1_700_000_000_000)
  })

  it('a byte-identical file digests identically, a changed one does not', () => {
    const a = readScopeFile(write('a.txt', '10.0.0.0/8\n')).provenance
    const b = readScopeFile(write('b.txt', '10.0.0.0/8\n')).provenance
    const c = readScopeFile(write('c.txt', '10.0.0.0/8\n# note\n')).provenance
    expect(a.digest).toBe(b.digest)
    expect(a.digest).not.toBe(c.digest)
  })

  it('records the mtime, so a file edited in place is visible', () => {
    const p = write('scope.txt', '10.0.0.0/8\n')
    expect(readScopeFile(p).provenance.modifiedAt).toBeGreaterThan(0)
  })

  it('counts the entries the parser actually extracted', () => {
    const p = write('scope.txt', '# a comment\n10.0.0.0/8\n\n*.example.com\n')
    const r = readScopeFile(p)
    expect(r.targets).toEqual(['10.0.0.0/8', '*.example.com'])
    expect(r.provenance.entries).toBe(2)
  })

  // The silent failure this exists to catch: a scope file that yields nothing
  // contributes no targets, and "scope active" reads exactly the same.
  it('a file that parses to zero entries is visible as zero, not as absent', () => {
    const p = write('scope.txt', '# only comments\n\n')
    const r = readScopeFile(p)
    expect(r.targets).toEqual([])
    expect(r.provenance.entries).toBe(0)
    expect(r.provenance.error).toBeUndefined()
    expect(r.provenance.digest).toBeTruthy()   // it WAS read — that is the point
  })

  it('an unreadable file says so instead of looking like an empty one', () => {
    const r = readScopeFile(path.join(dir, 'does-not-exist.txt'))
    expect(r.targets).toEqual([])
    expect(r.provenance.error).toBeTruthy()
    expect(r.provenance.digest).toBe('')
  })

  it('parses a Burp JSON scope and counts what it got', () => {
    const p = write('burp.json', JSON.stringify({ target: { scope: [{ host: '^example\\\\.com$' }, { host: '^api\\\\.example\\\\.com$' }] } }))
    const r = readScopeFile(p)
    expect(r.provenance.entries).toBe(2)
    expect(r.targets).toHaveLength(2)
  })

  it('loadScopeFile stays the targets-only view of the same read', () => {
    const p = write('scope.txt', '10.0.0.0/8\n*.example.com\n')
    expect(loadScopeFile(p)).toEqual(readScopeFile(p).targets)
  })

  it('a malformed JSON scope degrades to empty rather than throwing', () => {
    const p = write('broken.json', '{ not json')
    const r = readScopeFile(p)
    expect(r.targets).toEqual([])
    expect(r.provenance.digest).toBeTruthy()
  })
})
