// The hook-spool drain as src/main/index.ts runs it on project open and every
// 30 s, for tests that cannot load the Electron entry point.
//
// The drain's decisions live in a closure inside main's project-open function
// (`drainSpool`, src/main/index.ts, "Replay only records belonging to the
// active engagement"), not in an exported function, and Phase 1 of Spec 071
// changes no production code. So this is a copy of that closure, built only
// from exported production pieces: replaySpoolDirectory, ingest,
// isPauseJudgedGap / queueGapAgainstPauses / pauseIntervals,
// recordingStateRows and eventBus. `MAIN_DRAIN_SHAPE` lists the lines of
// main's closure that this copy depends on; `mainDrainDrift()` reports any that
// are no longer there, and the tests that use this helper assert it is empty —
// so the copy cannot go on testing a drain main no longer runs.
//
// Not copied: the reaping of mitm in-flight markers and the slicing, neither of
// which changes what a spool file becomes.

import fs from 'node:fs'
import path from 'node:path'
import { replaySpoolDirectory, type SpoolReplayEvent, type SpoolReplayResult } from '../../src/core/spool-replay'
import { ingest } from '../../src/core/ingest'
import { eventBus } from '../../src/core/event-bus'
import { isPauseJudgedGap, queueGapAgainstPauses, pauseIntervals } from '../../src/core/queue-gap'
import { recordingStateRows } from '../../src/core/db/events'

/** Fragments of main's drain, whitespace-collapsed, in the order they appear. */
export const MAIN_DRAIN_SHAPE = [
  'if (eventBus.paused) return null',
  'const data = isPauseJudgedGap(spooled) ? queueGapAgainstPauses(spooled, pauses ??= pauseIntervals(recordingStateRows())) : spooled',
  'if (!data) return true',
  "const result = ingest({ agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator, envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } } })",
  'if (result.event) return true',
  "return result.skipped !== 'paused'",
  'replaySpoolDirectory(pendingSpoolDirectory(homedir()), opening, emit, limit, after)'
]

/** The fragments of MAIN_DRAIN_SHAPE that main's drain no longer contains. */
export function mainDrainDrift(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  const start = src.indexOf('const drainSpool = (')
  const end = src.indexOf('try { drainSpool() }', start)
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
  if (eventBus.paused) return null
  let pauses: ReturnType<typeof pauseIntervals> | null = null
  const emit = ({ agentType, data: spooled, engagementId: spoolEngagement, operatorId: spoolOperator }: SpoolReplayEvent): boolean => {
    const data = isPauseJudgedGap(spooled)
      ? queueGapAgainstPauses(spooled, pauses ??= pauseIntervals(recordingStateRows()))
      : spooled
    if (!data) return true
    const result = ingest({
      agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator,
      envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } }
    })
    if (result.event) return true
    return result.skipped !== 'paused'
  }
  return replaySpoolDirectory(directory, opening, emit)
}
