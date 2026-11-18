import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { restrictToOwner, restrictToOwnerOnce } from '../src/core/fs-acl'
import { aclEntries, aclListing, clearIcacls, failNextIcacls, icaclsCalls, icaclsTargets, installIcaclsRecorder, isCurrentUser, useRealIcacls } from './helpers/icacls'

const IS_WIN = process.platform === 'win32'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realUser = process.env.USERNAME

describe('restrictToOwner off Windows', () => {
  it('is a no-op on non-win32', { skip: IS_WIN }, () => {
    useRealIcacls()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-'))
    try {
      const f = path.join(dir, 'secret')
      fs.writeFileSync(f, 'data', { mode: 0o600 })
      restrictToOwner(f)
      expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// What icacls does to NTFS, Windows leg only. The parent grants Users and
// Authenticated Users inheritable access, as a folder on a non-system drive
// does by default, so what is created in it starts with entries for every
// local account, and an icacls call that does nothing leaves them. Only what
// the CI log has shown is asserted: a file created by an elevated process
// outside such a parent carries explicit SYSTEM and Administrators entries,
// which restrictToOwner leaves, so no test counts entries there. The [ACL]
// lines in the log are the record.
describe.skipIf(!IS_WIN)('restrictToOwner under a parent that grants other local users access', () => {
  const OTHERS = ['BUILTIN\\Users', 'NT AUTHORITY\\Authenticated Users', 'Everyone']
  let parent: string

  // What restrictToOwner exists to remove: no entry for another local account.
  function expectNoOtherUsers(out: string): void {
    for (const other of OTHERS) expect(out, out).not.toContain(other)
  }

  beforeEach(() => {
    useRealIcacls()
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-hostile-'))
    // Users (S-1-5-32-545) and Authenticated Users (S-1-5-11), by SID so the
    // grant does not depend on the runner's language.
    execFileSync('icacls', [parent, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)', '*S-1-5-11:(OI)(CI)(M)'], { windowsHide: true })
  })

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true })
  })

  // The second half is what restrictToOwnerOnce relies on: the api-token is
  // rewritten in place on every project open and not restricted again.
  it('a file: only the current user\'s full control remains, and a rewrite in place keeps it', () => {
    const f = path.join(parent, 'api-token')
    fs.writeFileSync(f, 'SECRET')
    const before = aclListing(f)
    // The precondition (the runner is en-US, so icacls names them in English).
    expect(before, before).toContain('BUILTIN\\Users:(I)(RX)')
    expect(before, before).toContain('NT AUTHORITY\\Authenticated Users:(I)(M)')

    restrictToOwner(f)
    const out = aclListing(f)
    console.log(`[ACL] file before\n${before}\n[ACL] file after restrictToOwner\n${out}`)
    expectNoOtherUsers(out)
    expect(out, out).not.toContain('(I)')
    // Every entry the file had was inherited, so the user's is the only one.
    const entries = aclEntries(f, out)
    expect(entries, out).toHaveLength(1)
    expect(isCurrentUser(entries[0]), out).toBe(true)
    expect(entries[0], out).toMatch(/:\(F\)$/)

    fs.writeFileSync(f, 'rewritten', { mode: 0o600 })
    expect(aclListing(f)).toBe(out)
    expect(fs.readFileSync(f, 'utf-8')).toBe('rewritten')
  })

  // The user's grant on a directory is not inheritable, so a file created in
  // it afterwards takes what the directory still passes down, or the creating
  // process's default entries: never the parent's. No count is asserted.
  it('a directory: no entry for other users and nothing inherited, and none for them on a file created in it afterwards', () => {
    const d = path.join(parent, 'agent-transcripts')
    fs.mkdirSync(d)
    const before = aclListing(d)
    expect(before, before).toContain('BUILTIN\\Users:(I)')

    restrictToOwner(d)
    const dirOut = aclListing(d)
    const later = path.join(d, 'claude-code-later.jsonl')
    fs.writeFileSync(later, 'LATER')
    const laterOut = aclListing(later)
    console.log(`[ACL] directory before\n${before}\n[ACL] directory after restrictToOwner\n${dirOut}\n[ACL] file created in it afterwards\n${laterOut}`)

    expectNoOtherUsers(dirOut)
    expect(dirOut, dirOut).not.toContain('(I)')
    expect(aclEntries(d, dirOut).some((e) => isCurrentUser(e) && e.endsWith(':(F)')), dirOut).toBe(true)
    expectNoOtherUsers(laterOut)
    expect(fs.readFileSync(later, 'utf-8')).toBe('LATER')
  })
})

// The arguments, on test/setup.ts's record. Runs on every platform.
describe('restrictToOwner\'s icacls call', () => {
  let tmpDir: string

  beforeEach(() => {
    installIcaclsRecorder()
    clearIcacls()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.USERNAME = 'tester'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-args-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    if (realUser === undefined) delete process.env.USERNAME
    else process.env.USERNAME = realUser
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // test/setup.ts's switch lives on globalThis. Inside Electron it is ignored,
  // so nothing in a packaged app can turn restriction into a no-op through it.
  it('ignores the test switch when running under Electron', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    Object.defineProperty(process.versions, 'electron', { value: '99.0.0', configurable: true, enumerable: true })
    try {
      try { restrictToOwner(f) } catch { /* the real icacls, or off Windows its absence */ }
    } finally {
      delete (process.versions as Record<string, string | undefined>).electron
    }
    expect(icaclsCalls()).toEqual([])
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
    vi.restoreAllMocks()
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

  // A file system that reports a file index of all ones has none, as with 0:
  // every file on it would share one identity.
  it('runs every time for a file whose index is all ones', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    const real = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const s = real(p, opts as never) as fs.BigIntStats | fs.Stats
      if (opts && (opts as { bigint?: boolean }).bigint) return { ...s, ino: 0xFFFFFFFFFFFFFFFFn }
      return s
    }) as typeof fs.statSync)
    restrictToOwnerOnce(f)
    restrictToOwnerOnce(f)
    expect(icaclsTargets()).toEqual([f, f])
  })
})
