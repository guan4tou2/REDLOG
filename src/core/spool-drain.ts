// The hook-spool drain: what main runs on project open and every 30 s over
// ~/.redlog/pending, for the open project only.
//
// It lived as a closure inside main's project-open function, where no test
// could reach it; a test had to keep a copy and check the copy against main's
// source. It is here so main and the tests run the same code.
//
// One drain, in order:
//   0. Nothing while recording is paused: the files wait, as on main.
//   1. (first slice only) an earlier version's `.bad` / `.unattributed` files
//      are planned into quarantine (Spec 071 FR-069);
//   2. each waiting file of this project goes through the same kind policy a
//      bearer of the API token meets, narrowed for a file that carries no
//      credential (external-event-policy.ts, `legacy-handoff`); then the pause
//      rule below; then ingest() like every other producer;
//   3. what was not written is counted in one chained `system.capture_gap` per
//      reason per drain (FR-054) — and only once that row is committed are the
//      files it counts moved or removed. A row that cannot be written leaves
//      them in place and is reported like any other capture-write failure.
//
// The pause rule for a spool file (Spec 071 FR-082 as revised 2026-11-13): it
// is refused, intentionally and for good, if its source time is usable and lies
// inside a pause this project recorded (a recorded pause with no resume ends at
// the reopen). Otherwise it is written, at receipt — including a command_end
// observed before a pause, and a file whose source time is missing or not
// usable. A producer's own record of a loss is never refused as paused.

import { replaySpoolDirectory, migrateLegacySpoolFiles, applySpoolLosses, type SpoolLoss, type SpoolOutcome, type SpoolReplayEvent, type SpoolReplayOptions, type SpoolReplayResult } from './spool-replay'
import { isKindAllowed } from './external-event-policy'
import { ingest, committedEventOf } from './ingest'
import { isPauseJudgedGap, queueGapAgainstPauses, pauseIntervals } from './queue-gap'
import { recordingStateRows, sourceTimeRejection } from './db/events'
import { recordingStateAt, pauseBeganBetween } from './recording-state'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'

export interface SpoolDrainIdentity { engagementId: string; operatorId: string }

/** What one drain — every slice of it — has to count, committed at its end. */
export class SpoolDrainSession {
  private readonly groups = new Map<string, SpoolLoss>()
  constructor(private readonly opening: SpoolDrainIdentity) {}

  add(losses: readonly SpoolLoss[]): void {
    for (const loss of losses) {
      const key = `${loss.reason}\u0000${loss.owner}`
      const row = this.groups.get(key)
      if (!row) { this.groups.set(key, { ...loss, files: [...loss.files] }); continue }
      row.count += loss.count
      row.kept += loss.kept
      row.firstAt = Math.min(row.firstAt, loss.firstAt)
      row.lastAt = Math.max(row.lastAt, loss.lastAt)
      row.files.push(...loss.files)
    }
  }

  /** Write each gap row; apply its files' plan only once the row is there.
   *  Returns what each counted file became. */
  commit(): Record<string, 'quarantined' | 'dropped' | 'deferred'> {
    const out: Record<string, 'quarantined' | 'dropped' | 'deferred'> = {}
    for (const loss of this.groups.values()) {
      if (recordLoss(loss, this.opening)) Object.assign(out, applySpoolLosses([loss]))
      else for (const f of loss.files) out[f.name] = 'deferred'
    }
    this.groups.clear()
    return out
  }
}

/** A usable source time, by the rule the row's timestamp uses (FR-004), or
 *  null — a rejected one counts as none. */
function usableSourceTime(value: unknown, now: number): number | null {
  return value !== undefined && value !== null && sourceTimeRejection(value, now) === null ? value as number : null
}

/** Was this spooled item observed inside a pause the project recorded? */
function observedInRecordedPause(data: Record<string, unknown>, now: number): boolean {
  // A producer's record of its own loss is evidence about capture, not
  // captured content: never refused as paused.
  if (data.subtype === 'capture_gap') return false
  const at = usableSourceTime(data.source_timestamp, now)
  if (at === null) return false
  if (recordingStateAt(at) === 'paused') return true
  // A command's end that carries its output inline was observed from the
  // output's start: a pause recorded anywhere in between keeps it out.
  if (data.subtype === 'command_end' && data.output_streamed !== true) {
    const started = usableSourceTime(data.output_started_at, now)
    if (started !== null && started < at && (recordingStateAt(started) === 'paused' || pauseBeganBetween(started, at))) return true
  }
  return false
}

/** One drain of `directory` for the open project: up to `limit` files after
 *  `after`. Null while recording is paused. With a `session`, counted files
 *  wait for `session.commit()` (main commits once per drain, across slices);
 *  without one, they are committed before this returns. */
export function drainSpoolOnce(
  directory: string,
  opening: SpoolDrainIdentity,
  limit = Number.POSITIVE_INFINITY,
  after = '',
  options: SpoolReplayOptions = {},
  session?: SpoolDrainSession
): SpoolReplayResult | null {
  if (eventBus.paused) return null
  const clock = options.now ?? Date.now
  const own = session ?? new SpoolDrainSession(opening)
  const migrated = after === '' ? migrateLegacySpoolFiles(directory, opening, options) : null
  let pauses: ReturnType<typeof pauseIntervals> | null = null
  const emit = ({ agentType, data: spooled, engagementId: spoolEngagement, operatorId: spoolOperator }: SpoolReplayEvent): boolean | SpoolOutcome => {
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
    if (observedInRecordedPause(data, clock())) return { outcome: 'rejected', reason: 'paused' }
    // Through ingest(), like every other producer. Spooling is not rare — the
    // built-in terminal sources its adapter into a fresh pty within a second of
    // the pane opening, which is exactly when the API may not be up yet — so
    // the events most likely to take this path must get the whole pipeline.
    let result: ReturnType<typeof ingest>
    try {
      result = ingest({
        agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator, spoolJudged: true,
        envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } }
      })
    } catch (e) {
      // The row is in; a step after the commit threw. Retrying would write it
      // again.
      if (committedEventOf(e)) {
        console.error('[hook-spool] a step after the commit failed; the row is written:', e)
        noteDbError('hook-spool-post-commit', e)
        return true
      }
      throw e
    }
    if (result.event) return true
    // Recording was paused between slices: leave it for after the pause.
    if (result.skipped === 'paused') return false
    if (result.skipped === 'unrecorded') return { outcome: 'rejected', reason: 'terminal-not-recording' }
    // No row, but handled: `plumbing` is deliberately never recorded and
    // `dedup` means the row is already there. Both mean this file is done.
    return true
  }
  const run = replaySpoolDirectory(directory, opening, emit, limit, after, options)
  if (migrated) {
    run.losses = [...migrated.losses, ...run.losses]
    run.outcomes = { ...migrated.outcomes, ...run.outcomes }
  }
  own.add(run.losses)
  if (!session) Object.assign(run.outcomes, own.commit())
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
    : loss.reason === 'unreadable' ? 'could not be opened, after repeated tries'
    : loss.reason === 'failed' ? 'could not be written, after repeated tries'
    : `(${loss.reason})`
  const notKept = loss.count - loss.kept
  const where = loss.intentional ? '' : loss.kept > 0 ? `; kept in ~/.redlog/pending/quarantine` : ''
  const lost = !loss.intentional && notKept > 0 ? `; content not kept for ${notKept} (quarantine full)` : ''
  const owner = loss.owner === 'unknown' ? '; which project it belonged to is unknown' : ''
  return `${loss.count} spooled event(s) not recorded: ${what}${where}${lost}${owner}`
}

/** Commit a chained `system.capture_gap` for one group of losses, at the time
 *  the first of them was observed so it stands in its place on the Timeline.
 *  False when the row is not there — refused, deduplicated or thrown — and the
 *  failure is reported where capture-write failures are. */
function recordLoss(loss: SpoolLoss, opening: SpoolDrainIdentity): boolean {
  try {
    const result = ingest({
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
    if (result.event) return true
    throw new Error(`the ${loss.reason} gap row was not written (${result.skipped ?? 'no row'})`)
  } catch (e) {
    if (committedEventOf(e)) return true
    console.error(`[hook-spool] a ${loss.reason} gap of ${loss.count} could not be recorded; its files stay in the spool:`, e)
    noteDbError('hook-spool-gap', e)
    return false
  }
}
