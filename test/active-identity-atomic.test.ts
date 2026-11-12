// Spec 071 T014 (FR-013): ~/.redlog/active-identity.json is written so that a
// reader never sees half of it.
//
// Every shell hook reads the file on every event and stamps what it spools with
// it, and the spool keeps that stamp for as long as the file waits. The file was
// rewritten in place — truncate, then write — so a hook reading between the two,
// or the next start after a crash between them, found a file that named no
// project: the hook stopped spooling (shell-common.sh treats "no engagementId"
// as "no project open"), and a payload stamped from a torn read could not be
// attributed. Written to a temp file and renamed over the old one, a reader finds
// the old identity or the new one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeActiveIdentity } from '../src/core/active-identity'

const A = { engagementId: 'eng-a', operatorId: 'op-a' }
const B = { engagementId: 'eng-b', operatorId: 'op-b' }

describe('writing active-identity.json', () => {
  let dir = ''
  let file = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-identity-'))
    file = path.join(dir, '.redlog', 'active-identity.json')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the identity, creating the directory', () => {
    writeActiveIdentity(file, A)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(A)
  })

  it('a write that dies half-way leaves the previous identity whole, and no temp file behind', () => {
    writeActiveIdentity(file, A)
    const real = fs.writeFileSync
    // The disk fills after ten bytes of the new content.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      real(target, String(data).slice(0, 10), options)
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }) as typeof fs.writeFileSync)
    expect(() => writeActiveIdentity(file, B)).toThrow(/ENOSPC/)
    vi.restoreAllMocks()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')), 'a reader now finds half a file').toEqual(A)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['active-identity.json'])
  })

  it('replaces the identity whole', () => {
    writeActiveIdentity(file, A)
    writeActiveIdentity(file, B)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(B)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['active-identity.json'])
  })

  it('is owner-only where the mode bits mean something', () => {
    writeActiveIdentity(file, A)
    writeActiveIdentity(file, B)
    // Windows ignores the mode; fs-acl.ts restricts the directory there.
    const expected = process.platform === 'win32' ? fs.statSync(file).mode & 0o777 : 0o600
    expect(fs.statSync(file).mode & 0o777).toBe(expected)
  })
})
