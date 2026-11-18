// The unit suite's icacls. On Windows restrictToOwner runs icacls three times,
// each a child process that blocks for as long as the runner takes to start
// one, and every suite that opens a project went through several: on
// 2026-11-18 four PRs failed the Windows leg on a 15 s timeout in files they
// did not touch. test/setup.ts therefore records the arguments instead of
// spawning, for every file, and answers the current user's SID with
// TEST_USER_SID instead of running whoami.
//
// What icacls does to NTFS is proved on the Windows leg by the files that call
// useRealIcacls(): test/fs-acl.test.ts holds each restricted file and
// directory to exactly one entry, the current user's, including under a parent
// that grants other local users access, so it fails if restrictToOwner does
// nothing; test/tailer-sidecar-acl-win.test.ts does the same for the AI
// sidecar directory. That restrictToOwner is called for a protected path is
// proved against the record (test/acl-lifecycle-count.test.ts).
//
// The record is kept on the global so a file that calls vi.resetModules() and
// imports src/core/fs-acl again still writes into it.
import { execFileSync } from 'node:child_process'
import { _replaceIcaclsForTests } from '../../src/core/fs-acl'

interface IcaclsRecord { calls: string[][]; fail: Error | null }
const KEY = Symbol.for('redlog.test.icaclsRecord')

/** The SID the recorder reports for the current user. */
export const TEST_USER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001'

function record(): IcaclsRecord {
  const g = globalThis as Record<symbol, IcaclsRecord | undefined>
  return (g[KEY] ??= { calls: [], fail: null })
}

export function installIcaclsRecorder(): void {
  _replaceIcaclsForTests({
    icacls: (args) => {
      const r = record()
      r.calls.push(args)
      if (r.fail) { const e = r.fail; r.fail = null; throw e }
    },
    currentUserSid: () => TEST_USER_SID
  })
}

/** The real icacls, for a test that exists to see what it does to NTFS. */
export function useRealIcacls(): void { _replaceIcaclsForTests(null) }

/** The first argument of each recorded icacls call: the path it acted on. A
 *  restriction is three calls, so each restricted path appears three times. */
export function icaclsTargets(): string[] { return record().calls.map((args) => args[0]) }
/** The paths restricted, in order, one entry per restriction (its first
 *  call, `/reset`). */
export function icaclsRestricted(): string[] { return record().calls.filter((args) => args[1] === '/reset').map((args) => args[0]) }
export function icaclsCalls(): string[][] { return record().calls.map((args) => [...args]) }
export function clearIcacls(): void { record().calls.length = 0; record().fail = null }
/** The next recorded call throws, as a failed or timed-out icacls does. */
export function failNextIcacls(error = new Error('icacls failed')): void { record().fail = error }

// Reading a real ACL, for the Windows-only files above.

/** What icacls prints for a path. */
export const aclListing = (target: string): string => execFileSync('icacls', [target], { encoding: 'utf-8' })

/** The entries of a listing, one "principal:(flags)(rights)" each. icacls
 *  prints the path before the first, and a blank line and a summary after the
 *  last. */
export function aclEntries(target: string, out: string): string[] {
  const lines = out.split(/\r?\n/)
  const end = lines.findIndex((l) => l.trim() === '')
  return lines.slice(0, end < 0 ? lines.length : end).map((l, i) => {
    if (i > 0) return l.trim()
    if (!l.toLowerCase().startsWith(target.toLowerCase())) throw new Error(`icacls did not start its listing with ${target}:\n${out}`)
    return l.slice(target.length).trim()
  })
}

/** Is `entry`'s principal the account this process runs as? `whoami` names it
 *  domain\user; icacls may print it with or without the domain. */
export function isCurrentUser(entry: string): boolean {
  const me = execFileSync('whoami', { encoding: 'utf-8' }).trim().toLowerCase()
  const principal = entry.slice(0, entry.lastIndexOf(':(')).toLowerCase()
  return principal === me || principal === me.split('\\').pop()
}
