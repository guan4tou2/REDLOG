import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { restrictToOwner, restrictToOwnerOnce } from '../src/core/fs-acl'
import { clearIcacls, failNextIcacls, icaclsCalls, icaclsTargets, installIcaclsRecorder, useRealIcacls } from './helpers/icacls'

const IS_WIN = process.platform === 'win32'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realUser = process.env.USERNAME

describe('restrictToOwner', () => {
  let tmpDir: string

  // What icacls does to NTFS is this file's to prove, so it runs the real one.
  beforeEach(() => {
    useRealIcacls()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is a no-op on non-win32', { skip: IS_WIN }, () => {
    const f = path.join(tmpDir, 'secret')
    fs.writeFileSync(f, 'data', { mode: 0o600 })
    restrictToOwner(f)
    const stat = fs.statSync(f)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  // The second half is what restrictToOwnerOnce relies on: the api-token is
  // rewritten in place on every project open and not restricted again.
  it.skipIf(!IS_WIN)('restricts file ACL on Windows, and a rewrite in place keeps it', () => {
    const f = path.join(tmpDir, 'secret')
    fs.writeFileSync(f, 'data')
    restrictToOwner(f)
    const out = execFileSync('icacls', [f], { encoding: 'utf-8' })
    const user = process.env.USERNAME!
    expect(out).toContain(user)
    expect(out).not.toContain('Everyone')
    expect(out).not.toContain('BUILTIN\\Users')

    fs.writeFileSync(f, 'rewritten', { mode: 0o600 })
    const rewritten = execFileSync('icacls', [f], { encoding: 'utf-8' })
    console.log(`[ACL] restricted\n${out}\n[ACL] rewritten in place\n${rewritten}`)
    expect(rewritten).toBe(out)
  })

  it.skipIf(!IS_WIN)('restricts directory ACL on Windows', () => {
    const d = path.join(tmpDir, 'keys')
    fs.mkdirSync(d)
    restrictToOwner(d)
    const out = execFileSync('icacls', [d], { encoding: 'utf-8' })
    const user = process.env.USERNAME!
    expect(out).toContain(user)
    expect(out).not.toContain('Everyone')
    expect(out).not.toContain('BUILTIN\\Users')
  })

})

// The memo is what keeps project open from spawning icacls for the mirrored
// api-token every time. It is counted on test/setup.ts's record.
describe('restrictToOwnerOnce', () => {
  let tmpDir: string

  beforeEach(() => {
    installIcaclsRecorder()
    clearIcacls()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.USERNAME = 'tester'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-once-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    if (realUser === undefined) delete process.env.USERNAME
    else process.env.USERNAME = realUser
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs the same icacls as restrictToOwner', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    restrictToOwnerOnce(f)
    expect(icaclsCalls()).toEqual([[f, '/inheritance:r', '/grant:r', 'tester:(F)']])
  })

  it('does not run again for the same file written again in place', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.writeFileSync(f, 'two')
    restrictToOwnerOnce(f)
    restrictToOwnerOnce(path.join(tmpDir, '.', 'api-token'))
    expect(icaclsTargets()).toEqual([f])
  })

  it('runs again for a file removed and made again at the same path', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.rmSync(f)
    fs.writeFileSync(f, 'two')
    restrictToOwnerOnce(f)
    expect(icaclsTargets()).toEqual([f, f])
  })

  it('runs again for a file renamed over the restricted one', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.writeFileSync(f + '.tmp', 'two')
    fs.renameSync(f + '.tmp', f)
    restrictToOwnerOnce(f)
    expect(icaclsTargets()).toEqual([f, f])
  })

  it('throws a failed restriction and runs again on the next call', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    failNextIcacls()
    expect(() => restrictToOwnerOnce(f)).toThrow('icacls failed')
    restrictToOwnerOnce(f)
    restrictToOwnerOnce(f)
    expect(icaclsTargets()).toEqual([f, f])
  })

  it('keeps each path to itself', () => {
    const a = path.join(tmpDir, 'a'), b = path.join(tmpDir, 'b')
    fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'x')
    restrictToOwnerOnce(a); restrictToOwnerOnce(b); restrictToOwnerOnce(a)
    expect(icaclsTargets()).toEqual([a, b])
  })

  it('runs every time for a path it cannot identify', () => {
    const missing = path.join(tmpDir, 'not-there')
    restrictToOwnerOnce(missing)
    restrictToOwnerOnce(missing)
    expect(icaclsTargets()).toEqual([missing, missing])
  })
})
