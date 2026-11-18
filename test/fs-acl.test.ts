import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { restrictToOwner, restrictToOwnerOnce } from '../src/core/fs-acl'
import { TEST_USER_SID, aclEntries as aces, aclListing as listing, isCurrentUser as isMe, clearIcacls, failNextIcacls, icaclsCalls, icaclsRestricted, icaclsTargets, installIcaclsRecorder, useRealIcacls } from './helpers/icacls'

const IS_WIN = process.platform === 'win32'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

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
  it.skipIf(!IS_WIN)('leaves a file with one entry, the current user\'s, and a rewrite in place keeps it', () => {
    const f = path.join(tmpDir, 'secret')
    fs.writeFileSync(f, 'data')
    const before = listing(f)
    restrictToOwner(f)
    const out = listing(f)
    console.log(`[ACL] before\n${before}\n[ACL] restricted\n${out}`)
    const got = aces(f, out)
    expect(got, out).toHaveLength(1)
    expect(isMe(got[0]), out).toBe(true)
    expect(got[0], out).toMatch(/:\(F\)$/)

    fs.writeFileSync(f, 'rewritten', { mode: 0o600 })
    expect(listing(f)).toBe(out)
    expect(fs.readFileSync(f, 'utf-8')).toBe('rewritten')
  })

  it.skipIf(!IS_WIN)('leaves a directory with one inheritable entry, the current user\'s', () => {
    const d = path.join(tmpDir, 'keys')
    fs.mkdirSync(d)
    restrictToOwner(d)
    const out = listing(d)
    console.log(`[ACL] directory\n${out}`)
    const got = aces(d, out)
    expect(got, out).toHaveLength(1)
    expect(isMe(got[0]), out).toBe(true)
    expect(got[0], out).toMatch(/:\(OI\)\(CI\)\(F\)$/)
  })
})

// The hostile case, built explicitly: a parent folder that hands every local
// account read access to whatever is created in it, as a folder on a non-system
// drive does by default. Windows CI only; the [ACL] lines in the log are the
// record of what icacls did.
describe.skipIf(!IS_WIN)('restrictToOwner under a parent that grants other local users access', () => {
  const USERS = 'BUILTIN\\Users'
  const AUTH_USERS = 'NT AUTHORITY\\Authenticated Users'
  let parent: string

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

  function child(name: string): string {
    const f = path.join(parent, name)
    fs.writeFileSync(f, 'SECRET')
    const out = listing(f)
    // The precondition: the child inherited both. (The runner is en-US, so
    // icacls names them in English.)
    expect(out, out).toContain(`${USERS}:(I)(RX)`)
    expect(out, out).toContain(`${AUTH_USERS}:(I)(M)`)
    return f
  }

  // The control. The command restrictToOwner ran before this fix, exactly. The
  // finding inferred that it keeps the parent's inherited entries as explicit
  // ones; this asserts that, so a run that shows otherwise fails and says so.
  it('control: the old single icacls call leaves the Users entry on the file', () => {
    const f = child('old-command')
    execFileSync('icacls', [f, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { windowsHide: true })
    const out = listing(f)
    console.log(`[ACL] control: after the old command\n${out}`)
    expect(out, `The old command removed the Users entry, so the finding's inference does not hold. icacls printed:\n${out}`).toContain(USERS)
  })

  it('a file: one entry, the current user\'s, full control, nothing inherited', () => {
    const f = child('token')
    restrictToOwner(f)
    const out = listing(f)
    console.log(`[ACL] file after restrictToOwner\n${out}`)
    const got = aces(f, out)
    expect(got, out).toHaveLength(1)
    expect(isMe(got[0]), out).toBe(true)
    expect(got[0], out).toMatch(/:\(F\)$/)
    expect(fs.readFileSync(f, 'utf-8')).toBe('SECRET')
  })

  // What an existing install has: an explicit entry for other users, as the
  // old command may have left. Nothing about it is inherited, so only
  // replacing the whole list removes it.
  it('a file that carries an explicit Users entry: that entry goes too', () => {
    const f = child('explicit')
    execFileSync('icacls', [f, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true })
    expect(listing(f)).toContain(`${USERS}:(R)`)
    restrictToOwner(f)
    const out = listing(f)
    console.log(`[ACL] explicit entry after restrictToOwner\n${out}`)
    const got = aces(f, out)
    expect(got, out).toHaveLength(1)
    expect(isMe(got[0]), out).toBe(true)
  })

  it('a directory: one inheritable entry, and a file created in it afterwards is the current user\'s alone', () => {
    const d = path.join(parent, 'agent-transcripts')
    fs.mkdirSync(d)
    expect(listing(d)).toContain(USERS)
    restrictToOwner(d)
    const dirOut = listing(d)
    const dirAces = aces(d, dirOut)

    const later = path.join(d, 'claude-code-later.jsonl')
    fs.writeFileSync(later, 'LATER')
    const laterOut = listing(later)
    const laterAces = aces(later, laterOut)
    console.log(`[ACL] directory after restrictToOwner\n${dirOut}\n[ACL] file created in it afterwards\n${laterOut}`)

    expect(dirAces, dirOut).toHaveLength(1)
    expect(isMe(dirAces[0]), dirOut).toBe(true)
    expect(dirAces[0], dirOut).toMatch(/:\(OI\)\(CI\)\(F\)$/)
    expect(laterAces, laterOut).toHaveLength(1)
    expect(isMe(laterAces[0]), laterOut).toBe(true)
    expect(laterAces[0], laterOut).toMatch(/:\(I\)\(F\)$/)
    expect(fs.readFileSync(later, 'utf-8')).toBe('LATER')
  })
})

// The arguments, on test/setup.ts's record. Runs on every platform.
describe('restrictToOwner\'s icacls calls', () => {
  let tmpDir: string

  beforeEach(() => {
    installIcaclsRecorder()
    clearIcacls()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-args-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Each its own process: the documented syntax has no line that combines
  // /reset, /grant and /inheritance, and the one call that combined the last
  // two kept the inherited entries. Granting before removing inheritance means
  // the user never holds an ACL without their own entry in it.
  it('a file: reset, grant the current user by SID, remove what is inherited', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    restrictToOwner(f)
    expect(icaclsCalls()).toEqual([
      [f, '/reset'],
      [f, '/grant:r', `*${TEST_USER_SID}:(F)`],
      [f, '/inheritance:r']
    ])
  })

  it('a directory: the grant is inherited by what is created in it', () => {
    const d = path.join(tmpDir, 'keys')
    fs.mkdirSync(d)
    restrictToOwner(d)
    expect(icaclsCalls()).toEqual([
      [d, '/reset'],
      [d, '/grant:r', `*${TEST_USER_SID}:(OI)(CI)(F)`],
      [d, '/inheritance:r']
    ])
  })

  it('stops at the first call that fails and throws it', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    failNextIcacls()
    expect(() => restrictToOwner(f)).toThrow('icacls failed')
    expect(icaclsCalls()).toEqual([[f, '/reset']])
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-once-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs the same icacls as restrictToOwner', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    restrictToOwnerOnce(f)
    const once = icaclsCalls()
    clearIcacls()
    restrictToOwner(f)
    expect(once).toEqual(icaclsCalls())
    expect(once).toHaveLength(3)
  })

  it('does not run again for the same file written again in place', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.writeFileSync(f, 'two')
    restrictToOwnerOnce(f)
    restrictToOwnerOnce(path.join(tmpDir, '.', 'api-token'))
    expect(icaclsRestricted()).toEqual([f])
    expect(icaclsTargets()).toEqual([f, f, f])
  })

  it('runs again for a file removed and made again at the same path', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.rmSync(f)
    fs.writeFileSync(f, 'two')
    restrictToOwnerOnce(f)
    expect(icaclsRestricted()).toEqual([f, f])
  })

  it('runs again for a file renamed over the restricted one', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'one')
    restrictToOwnerOnce(f)
    fs.writeFileSync(f + '.tmp', 'two')
    fs.renameSync(f + '.tmp', f)
    restrictToOwnerOnce(f)
    expect(icaclsRestricted()).toEqual([f, f])
  })

  it('throws a failed restriction and runs again on the next call', () => {
    const f = path.join(tmpDir, 'api-token')
    fs.writeFileSync(f, 'x')
    failNextIcacls()
    expect(() => restrictToOwnerOnce(f)).toThrow('icacls failed')
    restrictToOwnerOnce(f)
    restrictToOwnerOnce(f)
    expect(icaclsRestricted()).toEqual([f, f])
  })

  it('keeps each path to itself', () => {
    const a = path.join(tmpDir, 'a'), b = path.join(tmpDir, 'b')
    fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'x')
    restrictToOwnerOnce(a); restrictToOwnerOnce(b); restrictToOwnerOnce(a)
    expect(icaclsRestricted()).toEqual([a, b])
  })

  it('runs every time for a path it cannot identify', () => {
    const missing = path.join(tmpDir, 'not-there')
    restrictToOwnerOnce(missing)
    restrictToOwnerOnce(missing)
    expect(icaclsRestricted()).toEqual([missing, missing])
  })

})
