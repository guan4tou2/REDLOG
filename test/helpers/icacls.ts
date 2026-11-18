// The unit suite's icacls. On Windows restrictToOwner is an icacls child
// process that blocks for as long as the runner takes to start one (up to its
// 5 s timeout), and every suite that opens a project went through several: on
// 2026-11-18 four PRs failed the Windows leg on a 15 s timeout in files they
// did not touch. test/setup.ts therefore records the arguments instead of
// spawning, for every file. What icacls does to NTFS is proved by the files
// that call useRealIcacls(): test/fs-acl.test.ts and
// test/tailer-sidecar-acl-win.test.ts. That restrictToOwner is called for a
// protected path is proved against the record (test/acl-lifecycle-count.test.ts).
//
// The record is kept on the global so a file that calls vi.resetModules() and
// imports src/core/fs-acl again still writes into it.
import { _replaceIcaclsForTests } from '../../src/core/fs-acl'

interface IcaclsRecord { calls: string[][]; fail: Error | null }
const KEY = Symbol.for('redlog.test.icaclsRecord')

function record(): IcaclsRecord {
  const g = globalThis as Record<symbol, IcaclsRecord | undefined>
  return (g[KEY] ??= { calls: [], fail: null })
}

export function installIcaclsRecorder(): void {
  _replaceIcaclsForTests((args) => {
    const r = record()
    r.calls.push(args)
    if (r.fail) { const e = r.fail; r.fail = null; throw e }
  })
}

/** The real icacls, for a test that exists to see what it does to NTFS. */
export function useRealIcacls(): void { _replaceIcaclsForTests(null) }

/** The first argument of each recorded icacls call: the path it restricted. */
export function icaclsTargets(): string[] { return record().calls.map((args) => args[0]) }
export function icaclsCalls(): string[][] { return record().calls.map((args) => [...args]) }
export function clearIcacls(): void { record().calls.length = 0; record().fail = null }
/** The next recorded call throws, as a failed or timed-out icacls does. */
export function failNextIcacls(error = new Error('icacls failed')): void { record().fail = error }
