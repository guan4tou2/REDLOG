// The hook-spool drain: what main runs on project open and every 30 s over
// ~/.redlog/pending, for the open project only.
//
// It lived as a closure inside main's project-open function, where no test
// could reach it; a test had to keep a copy and check the copy against main's
// source. It is here so main and the tests run the same code.
//
// One drain, in order:
//   1. (first slice only) an earlier version's `.bad` / `.unattributed` files
//      are moved into quarantine (Spec 071 FR-069);
//   2. each waiting file of this project goes through the same kind policy a
//      bearer of the API token meets, narrowed for a file that carries no
//      credential (external-event-policy.ts, `legacy-handoff`), then through
//      ingest() like every other producer;
//   3. what was not written — quarantined, or rejected — is counted in a
//      chained `system.capture_gap` row in this project (FR-054), so a loss is
//      on the Timeline and in every export, not only in a directory listing.

import { replaySpoolDirectory, migrateLegacySpoolFiles, type SpoolLoss, type SpoolOutcome, type SpoolReplayEvent, type SpoolReplayOptions, type SpoolReplayResult } from './spool-replay'
import { isKindAllowed } from './external-event-policy'
import { ingest } from './ingest'
import { isPauseJudgedGap, queueGapAgainstPauses, pauseIntervals } from './queue-gap'
import { recordingStateRows } from './db/events'
import { recordingStateAt } from './recording-state'
import { eventBus } from './event-bus'

export interface SpoolDrainIdentity { engagementId: string; operatorId: string }

/** One drain of `directory` for the open project: up to `limit` files after
 *  `after`. */
export function drainSpoolOnce(
  directory: string,
  opening: SpoolDrainIdentity,
  limit = Number.POSITIVE_INFINITY,
  after = '',
  options: SpoolReplayOptions = {}
): SpoolReplayResult {
  // No "if paused, wait": whether an item was recorded is decided by when it
  // was observed (Spec 071 FR-082), so a file observed before a pause is
  // written while the pause lasts, and one observed during it never is.
  const migrated = after === '' ? migrateLegacySpoolFiles(directory, opening, options).losses : []
  let pauses: ReturnType<typeof pauseIntervals> | null = null
  const emit = ({ agentType, data: spooled, engagementId: spoolEngagement, operatorId: spoolOperator, observedAt }: SpoolReplayEvent): boolean | SpoolOutcome => {
    // The question the API asks, asked first: a forged file gets no further.
    if (!isKindAllowed('legacy-handoff', agentType, spooled)) {
      return { outcome: 'invalid', reason: 'kind-not-allowed', detail: `agent_type "${agentType}" may not be written through the spool` }
    }
    // A queue-full or proxy-stop gap is judged against the pauses before it
    // lands: one counted entirely while paused is not a loss, and is done
    // with (#460, #291).
    const data = isPauseJudgedGap(spooled)
      ? queueGapAgainstPauses(spooled, pauses ??= pauseIntervals(recordingStateRows()))
      : spooled
    if (!data) return true
    const judgedGap = isPauseJudgedGap(spooled)
    // A file with no source time is judged by receipt time in ingest (FR-004),
    // and its row is stamped with it; but it was observed no later than it was
    // written. Written inside a recorded pause: never recorded. Written outside
    // one but drained during the pause in effect now: left for after it, so the
    // row is neither lost nor stamped inside the pause. (Every hook RedLog ships
    // sends a source time; this is older hooks and hand-made files.)
    if (!judgedGap && (data.source_timestamp === undefined || data.source_timestamp === null)) {
      if (recordingStateAt(observedAt) === 'paused') return { outcome: 'rejected', reason: 'paused' }
      if (eventBus.paused) return false
    }
    // Through ingest(), like every other producer. Spooling is not rare — the
    // built-in terminal sources its adapter into a fresh pty within a second of
    // the pane opening, which is exactly when the API may not be up yet — so
    // the events most likely to take this path must get the whole pipeline.
    // A gap already judged against the pauses above is not judged again.
    const result = ingest({
      agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator,
      ...(judgedGap ? { bypassPause: true } : {}),
      envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } }
    })
    if (result.event) return true
    // Observed during a pause, or from a terminal that was not recording: never
    // written, now or later; counted.
    if (result.skipped === 'paused') return { outcome: 'rejected', reason: 'paused' }
    if (result.skipped === 'unrecorded') return { outcome: 'rejected', reason: 'terminal-not-recording' }
    // No row, but handled: `plumbing` is deliberately never recorded and
    // `dedup` means the row is already there. Both mean this file is done.
    return true
  }
  const run = replaySpoolDirectory(directory, opening, emit, limit, after, options)
  run.losses = [...migrated, ...run.losses]
  for (const loss of run.losses) recordLoss(loss, opening)
  return run
}

/** Words for the gap row. The row carries the numbers; this is what a reader
 *  of the Timeline or an export sees without opening it. */
function describeLoss(loss: SpoolLoss): string {
  const what = loss.reason === 'paused' ? 'observed while recording was paused'
    : loss.reason === 'terminal-not-recording' ? 'from a terminal that was not recording'
    : loss.reason === 'kind-not-allowed' ? 'named a kind the spool may not write'
    : loss.reason === 'malformed' ? 'could not be read'
    : loss.reason === 'legacy-bad' ? 'had been set aside as unreadable by an earlier version'
    : `(${loss.reason})`
  const notKept = loss.count - loss.kept
  const where = loss.intentional ? '' : loss.kept > 0 ? `; kept in ~/.redlog/pending/quarantine` : ''
  const lost = !loss.intentional && notKept > 0 ? `; content not kept for ${notKept} (quarantine full)` : ''
  const owner = loss.owner === 'unknown' ? '; which project it belonged to is unknown' : ''
  return `${loss.count} spooled event(s) not recorded: ${what}${where}${lost}${owner}`
}

/** A chained `system.capture_gap` for one group of losses, at the time the
 *  first of them was observed so it stands in its place on the Timeline. */
function recordLoss(loss: SpoolLoss, opening: SpoolDrainIdentity): void {
  try {
    ingest({
      agentType: 'system', engagementId: opening.engagementId, operatorId: opening.operatorId,
      occurredAt: loss.firstAt,
      data: {
        subtype: 'capture_gap', source: 'hook-spool', reason: loss.reason,
        intentional: loss.intentional,
        skipped_units: loss.count,
        quarantined: loss.kept,
        ...(!loss.intentional && loss.kept < loss.count ? { content_not_kept: loss.count - loss.kept } : {}),
        ...(loss.owner === 'unknown' ? { owner: 'unknown' } : {}),
        gap_started_at: loss.firstAt, gap_ended_at: loss.lastAt,
        description: describeLoss(loss)
      }
    })
  } catch (e) {
    console.error(`[hook-spool] a ${loss.reason} gap of ${loss.count} could not be recorded:`, e)
  }
}
