// The hook-spool drain as src/main/index.ts runs it on project open and every
// 30 s, for tests that cannot load the Electron entry point.
//
// Until Spec 071 Phase 2 the drain was a closure inside main's project-open
// function, and this file held a copy of it with a check against main's source.
// The drain is now src/core/spool-drain.ts `drainSpoolOnce`, and main's closure
// only guards it (the project is still current) and reaps the proxy's in-flight
// markers first. So this runs the real thing, and `mainDrainDrift()` checks only
// that main still calls it — a test through here cannot be testing a drain main
// no longer runs.
//
// Not run here: the reaping of mitm in-flight markers and the slicing, neither
// of which changes what a spool file becomes.

import fs from 'node:fs'
import path from 'node:path'
import { drainSpoolOnce } from '../../src/core/spool-drain'
import type { SpoolReplayResult } from '../../src/core/spool-replay'

/** Fragments of main's drain, whitespace-collapsed, in the order they appear. */
export const MAIN_DRAIN_SHAPE = [
  'if (!projectRuntime.isCurrent(opening)) return null',
  'spoolSession = new SpoolDrainSession(opening)',
  'drainSpoolOnce(pendingSpoolDirectory(homedir()), opening, limit, after, {}, spoolSession ?? undefined)',
  'if (session && projectRuntime.isCurrent(opening)) session.commit()'
]

/** The fragments of MAIN_DRAIN_SHAPE that main's drain no longer contains. */
export function mainDrainDrift(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  const start = src.indexOf('const drainSpool = (')
  const end = src.indexOf('startSpoolDrain({', start)
  if (start < 0 || end < 0) return ['drainSpool closure not found in src/main/index.ts']
  const body = src.slice(start, end)
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join(' ')
    .replace(/\s+/g, ' ')
  const missing: string[] = []
  let at = 0
  for (const fragment of MAIN_DRAIN_SHAPE) {
    const i = body.indexOf(fragment, at)
    if (i < 0) missing.push(fragment)
    else at = i + fragment.length
  }
  return missing
}

/** One drain of `directory` for the open project, as main does it. */
export function drainSpoolAsMain(directory: string, opening: { engagementId: string; operatorId: string }): SpoolReplayResult | null {
  return drainSpoolOnce(directory, opening)
}
