import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

interface AclRunner {
  icacls(args: string[], timeoutMs: number): void
  currentUserSid(timeoutMs: number): string
}

// Files and directories this process has restricted, keyed by resolved path and
// holding the identity they had when it was done. Each restriction is three
// icacls child processes that block the main process, and the mirrored
// ~/.redlog/api-token was restricted again on every project open.
const restricted = new Map<string, string>()

// The current user's SID, asked of whoami once per process.
let currentSid: string | null = null

/** Whole-operation bound for one restriction: every child process it starts
 *  shares it. */
const RESTRICT_BUDGET_MS = 10_000

const real: AclRunner = {
  icacls(args, timeoutMs) {
    execFileSync('icacls', args, { windowsHide: true, timeout: timeoutMs })
  },
  currentUserSid(timeoutMs) {
    // CSV, no header: "domain\user","S-1-5-21-…". The SID is not localised.
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    const sid = /"(S-1-\d+(?:-\d+)+)"/.exec(out)?.[1]
    if (!sid) throw new Error(`whoami /user printed no SID: ${out.trim()}`)
    return sid
  }
}

// Where a test-setup replacement of the icacls and whoami spawns is kept: on
// the global, not in this module, so a test that calls vi.resetModules() and
// imports this file again still finds it. Production never sets it, and under
// Electron it is not read at all: nothing in the app can turn restriction into
// a no-op through the global.
const TEST_RUNNER = Symbol.for('redlog.test.icaclsRunner')

function runner(): AclRunner {
  if (process.versions.electron) return real
  const replaced = (globalThis as Record<symbol, unknown>)[TEST_RUNNER]
  return replaced && typeof replaced === 'object' ? replaced as AclRunner : real
}

/** Unit tests only (test/setup.ts): replace the icacls and whoami spawns with
 *  `replacement`, or put the real ones back with null. */
export function _replaceIcaclsForTests(replacement: AclRunner | null): void {
  const g = globalThis as Record<symbol, unknown>
  if (replacement) g[TEST_RUNNER] = replacement
  else delete g[TEST_RUNNER]
  restricted.clear()
  currentSid = null
}

/**
 * On Windows, leave a file or directory with exactly one access entry: the
 * current user, full control, nothing inherited. A directory's entry is
 * inheritable, (OI)(CI), so what is created in it afterwards is the current
 * user's alone without a call of its own. SYSTEM and Administrators get no
 * entry: they are not needed to protect against another local account, and a
 * process holding the backup privilege or an administrator taking ownership
 * reads the file whatever its ACL says.
 *
 * Three icacls processes, in this order, so the result does not depend on what
 * the file held before:
 *   1. `/reset` — drop every explicit entry (an older version, or anyone,
 *      may have left one) and take the parent's inherited ones;
 *   2. `/grant:r *<SID>:(F)` — the current user, by SID, so the grant does not
 *      depend on account names, the domain or the system language;
 *   3. `/inheritance:r` — remove the inherited entries and stop inheritance.
 * Granting before removing inheritance keeps the user's own entry in the ACL
 * at every step. Before this, one call combined `/inheritance:r /grant:r`,
 * which kept the inherited entries as explicit ones.
 *
 * No-op on non-win32 platforms (POSIX mode already handles it).
 * Failures are thrown — callers decide whether to swallow or propagate. All
 * the processes share one bound of RESTRICT_BUDGET_MS.
 */
export function restrictToOwner(target: string): void {
  if (process.platform !== 'win32') return
  const deadline = Date.now() + RESTRICT_BUDGET_MS
  const left = (): number => {
    const ms = deadline - Date.now()
    if (ms <= 0) throw new Error(`restricting ${target} took longer than ${RESTRICT_BUDGET_MS} ms`)
    return ms
  }
  const run = runner()
  const sid = run === real ? (currentSid ??= run.currentUserSid(left())) : run.currentUserSid(left())
  let isDir = false
  try { isDir = fs.statSync(target).isDirectory() } catch { /* icacls reports the missing path */ }
  run.icacls([target, '/reset'], left())
  run.icacls([target, '/grant:r', `*${sid}:${isDir ? '(OI)(CI)(F)' : '(F)'}`], left())
  run.icacls([target, '/inheritance:r'], left())
}

/** Null when the identity cannot be told apart from another file's: a file
 *  system that reports no file index (0, or all ones) cannot be memoised
 *  safely. */
function identity(target: string): string | null {
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
