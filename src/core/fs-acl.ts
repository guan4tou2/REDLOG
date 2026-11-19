import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type IcaclsRunner = (args: string[]) => void

// Files and directories this process has restricted, keyed by resolved path and
// holding the identity they had when it was done. Each restriction is an icacls
// child process that blocks the main process for up to 5 s, and the mirrored
// ~/.redlog/api-token was restricted again on every project open.
const restricted = new Map<string, string>()

// Where a test-setup replacement of the icacls spawn is kept: on the global,
// not in this module, so a test that calls vi.resetModules() and imports this
// file again still finds it. Production never sets it, and under Electron it is
// not read at all: nothing in the app can turn restriction into a no-op
// through the global.
const TEST_RUNNER = Symbol.for('redlog.test.icaclsRunner')

function runIcacls(args: string[]): void {
  const replaced = process.versions.electron ? undefined : (globalThis as Record<symbol, unknown>)[TEST_RUNNER]
  if (typeof replaced === 'function') { (replaced as IcaclsRunner)(args); return }
  execFileSync('icacls', args, { windowsHide: true, timeout: 5000 })
}

/** Unit tests only (test/setup.ts): replace the icacls spawn with `runner`,
 *  or put the real one back with null. */
export function _replaceIcaclsForTests(runner: IcaclsRunner | null): void {
  const g = globalThis as Record<symbol, unknown>
  if (runner) g[TEST_RUNNER] = runner
  else delete g[TEST_RUNNER]
  restricted.clear()
}

/**
 * On Windows, keep other local accounts out of a file or directory. One icacls
 * call, `/inheritance:r /grant:r USERNAME:(F)`: it stops inheritance, removes
 * every inherited entry, and gives the current user full control. Explicit
 * entries the target already carried for other principals are left as they
 * are: a file an elevated process creates has explicit SYSTEM and
 * Administrators entries, and keeps them. Nothing the parent folder grants
 * (Users, Authenticated Users) survives. Use the inheritable grant on a
 * directory whose children need the user's entry.
 * POSIX mode bits are silently ignored by NTFS; this fills the gap with icacls.
 *
 * No-op on non-win32 platforms (POSIX mode already handles it).
 * Failures are thrown — callers decide whether to swallow or propagate.
 */
export function restrictToOwner(target: string, grant: 'target' | 'inheritable' = 'target'): void {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) throw new Error('USERNAME env var is not set')
  const rights = grant === 'inheritable' ? '(OI)(CI)(F)' : '(F)'
  runIcacls([target, '/inheritance:r', '/grant:r', `${user}:${rights}`])
}

/** Null when the identity cannot be told apart from another file's: a file
 *  system that reports no file index (0, or all ones) cannot be identified
 *  safely. */
export function identity(target: string): string | null {
  try {
    const s = fs.statSync(target, { bigint: true })
    if (s.ino === 0n || s.ino === 0xFFFFFFFFFFFFFFFFn) return null
    return `${s.dev}:${s.ino}:${s.birthtimeNs}`
  } catch { return null }
}

/**
 * restrictToOwner, skipped when this process already restricted this same
 * file or directory. "Same" is the identity (volume, file index, creation
 * time), not the path: rewriting a file in place keeps its ACL and its
 * identity, while a file removed and made again, or renamed over, is a new
 * file with a new index and the default ACL, and is restricted again. Only a
 * restriction that took effect is remembered; a failure throws as
 * restrictToOwner does and is retried on the next call.
 *
 * The memo is not a check of the ACL: if someone widens it while the app runs,
 * it stays widened until the next app start, when the first call restricts it
 * again.
 */
export function restrictToOwnerOnce(target: string): void {
  if (process.platform !== 'win32') return
  const key = path.resolve(target)
  const id = identity(key)
  if (id !== null && restricted.get(key) === id) return
  restrictToOwner(target)
  if (id !== null) restricted.set(key, id)
}
