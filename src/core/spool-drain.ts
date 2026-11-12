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
//   3. what was not written is counted in chained `system.capture_gap` rows —
//      one per reason per drain, split only when one reason counts more than
//      FILES_PER_ROW files (FR-054) — each naming the files it counts. Only
//      once a row is committed are its files moved or removed. A row that
//      cannot be written leaves them in place, uncounted, and is reported like
//      any other capture-write failure. A file a committed row already names
//      is never counted again (the chain is the record); only its move or
//      removal is retried.
//
// The pause rule for a spool file (Spec 071 FR-082/083 as revised 2026-11-13):
// it is refused, intentionally and for good, if a usable time of its
// observation lies inside a pause this project recorded. Otherwise it is
// written, at receipt. While the record holds a pause begun in this session
// with no resume yet, any file it could bear on waits. A producer's own record
// of a loss is never refused as paused.

import {
  replaySpoolDirectory, migrateLegacySpoolFiles, applySpoolActions, QuarantineLedger,
  type PlannedFile, type SpoolLoss, type SpoolOutcome, type SpoolReplayEvent, type SpoolReplayOptions, type SpoolReplayResult
} from './spool-replay'
import { isKindAllowed } from './external-event-policy'
import { ingest, committedEventOf } from './ingest'
import { isPauseJudgedGap, queueGapAgainstPauses } from './queue-gap'
import { sourceTimeRejection } from './db/events'
import { getDB } from './db/index'
import { recordedPauses, stateAt, spanBeganIn, pausedIntervals, reachesUnknown, type RecordedPauses } from './recording-state'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'

export interface SpoolDrainIdentity { engagementId: string; operatorId: string }

/** The most file names one gap row carries. A reason that counts more in one
 *  drain is written as several rows (`part` of `parts`). */
export const FILES_PER_ROW = 100

/** Spool file names this project's committed gap rows have counted, with the
 *  reason each was counted under. Read from the chain. */
function countedInChain(): Map<string, string> {
  const out = new Map<string, string>()
  let rows: Array<{ data: string }> = []
  try {
    rows = getDB().prepare(`SELECT data FROM events WHERE agent_type = 'system' AND subtype = 'capture_gap'`).all() as typeof rows
  } catch { return out }
  for (const row of rows) {
    let data: { source?: unknown; reason?: unknown; files?: unknown }
    try { data = JSON.parse(row.data) as typeof data } catch { continue }
    if (data.source !== 'hook-spool' || !Array.isArray(data.files)) continue
    for (const name of data.files) if (typeof name === 'string') out.set(name, String(data.reason))
  }
  return out
}

/** What one drain — every slice of it — has to count, committed at its end,
 *  and the quarantine room every slice of it shares. */
export class SpoolDrainSession {
  private readonly groups = new Map<string, SpoolLoss>()
  private retries: PlannedFile[] = []
  private ledger: QuarantineLedger | null = null
  private counted: Map<string, string> | null = null
  constructor(private readonly opening: SpoolDrainIdentity) {}

  /** The options a slice replays with: this drain's ledger and the chain's
   *  record of what is already counted. */
  options(given: SpoolReplayOptions): SpoolReplayOptions {
    this.ledger ??= given.ledger ?? new QuarantineLedger(given.quarantineMaxFiles, given.quarantineMaxBytes)
    const counted = this.counted ??= countedInChain()
    return { ...given, ledger: this.ledger, countedAs: (name) => counted.get(name) ?? null }
  }

  add(losses: readonly SpoolLoss[], retries: readonly PlannedFile[] = []): void {
    for (const loss of losses) {
      const row = this.groups.get(loss.reason)
      if (!row) { this.groups.set(loss.reason, { ...loss, owners: { ...loss.owners }, files: [...loss.files] }); continue }
      row.count += loss.count
      row.kept += loss.kept
      row.owners.this += loss.owners.this
      row.owners.unknown += loss.owners.unknown
      row.firstAt = Math.min(row.firstAt, loss.firstAt)
      row.lastAt = Math.max(row.lastAt, loss.lastAt)
      row.files.push(...loss.files)
    }
    this.retries.push(...retries)
  }

  /** Write each gap row; apply its files' plan only once the row is there.
   *  Returns what each counted file became. While recording is paused nothing
   *  is written or moved: the plan is dropped and every file stays, to be
   *  judged again by a drain after the pause. */
  commit(): Record<string, 'quarantined' | 'dropped' | 'deferred'> {
    const out: Record<string, 'quarantined' | 'dropped' | 'deferred'> = {}
    const groups = [...this.groups.values()]
    const retries = this.retries
    this.groups.clear()
    this.retries = []
    if (eventBus.paused) {
      for (const f of [...groups.flatMap((g) => g.files), ...retries]) out[f.name] = 'deferred'
      return out
    }
    Object.assign(out, applySpoolActions(retries))
    for (const loss of groups) {
      const parts = chunk(loss.files, FILES_PER_ROW)
      parts.forEach((files, index) => {
        const row = lossOf(loss, files)
        if (recordLoss(row, this.opening, parts.length > 1 ? { part: index + 1, parts: parts.length } : null)) {
          for (const f of files) this.counted?.set(f.name, loss.reason)
          Object.assign(out, applySpoolActions(files))
        } else {
          for (const f of files) out[f.name] = 'deferred'
        }
      })
    }
    return out
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out.length ? out : [[]]
}

/** The numbers of one row, from the files it names. */
function lossOf(group: SpoolLoss, files: PlannedFile[]): SpoolLoss {
  const times = files.map((f) => f.at ?? group.firstAt)
  return {
    reason: group.reason,
    intentional: group.intentional,
    count: files.length,
    kept: files.filter((f) => f.action.kind !== 'unlink').length,
    owners: { this: files.filter((f) => f.owner !== 'unknown').length, unknown: files.filter((f) => f.owner === 'unknown').length },
    firstAt: Math.min(...times),
    lastAt: Math.max(...times),
    files
  }
}

/** A usable source time, by the rule the row's timestamp uses (FR-004), or
 *  null — a rejected one counts as none. */
function usableSourceTime(value: unknown, now: number): number | null {
  return value !== undefined && value !== null && sourceTimeRejection(value, now) === null ? value as number : null
}

/** Was this spooled item observed inside a pause the project recorded?
 *  'paused' or 'pause-end-unknown' to refuse it, 'unknown' when the record
 *  cannot say yet, null to write it. */
function observedInRecordedPause(data: Record<string, unknown>, pauses: RecordedPauses, now: number): 'paused' | 'pause-end-unknown' | 'unknown' | null {
  // A producer's record of its own loss is evidence about capture, not
  // captured content: never refused as paused.
  if (data.subtype === 'capture_gap') return null
  const at = usableSourceTime(data.source_timestamp, now)
  const times: number[] = []
  if (at !== null) times.push(at)
  let spanned: ReturnType<typeof spanBeganIn> = null
  if (data.subtype === 'command_end') {
    // A command's end carries what was typed, and its output, from before its
    // own time. Its start is the output's start when the producer gave one,
    // else its end less its duration.
    const outputStarted = usableSourceTime(data.output_started_at, now)
    const duration = typeof data.duration_sec === 'number' && Number.isFinite(data.duration_sec) && data.duration_sec >= 0 ? data.duration_sec : null
    const started = outputStarted ?? (at !== null && duration !== null ? at - duration * 1000 : null)
    if (started !== null) times.push(started)
    // Output that began before a pause and ended after it: refused whole.
    if (outputStarted !== null && at !== null && outputStarted < at) spanned = spanBeganIn(pauses, outputStarted, at)
  }
  const states: string[] = times.map((t) => stateAt(pauses, t))
  if (spanned) states.push(spanned)
  if (states.includes('paused')) return 'paused'
  if (states.includes('unknown')) return 'unknown'
  // No usable time at all: nothing places it, unless the record is still open.
  if (times.length === 0 && pauses.unknownFrom !== null) return 'unknown'
  if (states.includes('pause-end-unknown')) return 'pause-end-unknown'
  return null
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
  const sliceOptions = own.options(options)
  const migrated = after === '' ? migrateLegacySpoolFiles(directory, opening, sliceOptions) : null
  const pauses = recordedPauses()
  const emit = ({ agentType, data: spooled, engagementId: spoolEngagement, operatorId: spoolOperator }: SpoolReplayEvent): boolean | SpoolOutcome => {
    // The question the API asks, asked first: a forged file gets no further.
    if (!isKindAllowed('legacy-handoff', agentType, spooled)) {
      return { outcome: 'invalid', reason: 'kind-not-allowed', detail: `agent_type "${agentType}" may not be written through the spool` }
    }
    // A queue-full or proxy-stop gap is judged against the pauses before it
    // lands: one counted entirely while paused is not a loss, and is done
    // with (#460, #291). Against the same record, with the same end for a
    // pause the record has not closed: one that reaches into it waits.
    let data: Record<string, unknown> | null = spooled
    if (isPauseJudgedGap(spooled)) {
      const start = Number(spooled.gap_started_at)
      const end = Number(spooled.gap_ended_at ?? spooled.gap_started_at)
      if (Number.isFinite(start) && Number.isFinite(end) && reachesUnknown(pauses, start, end)) return false
      data = queueGapAgainstPauses(spooled, pausedIntervals(pauses))
    }
    if (!data) return true
    const inPause = observedInRecordedPause(data, pauses, clock())
    if (inPause === 'unknown') return false
    if (inPause) return { outcome: 'rejected', reason: inPause }
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
  const run = replaySpoolDirectory(directory, opening, emit, limit, after, sliceOptions)
  if (migrated) {
    run.losses = [...migrated.losses, ...run.losses]
    run.retries = [...migrated.retries, ...run.retries]
    run.outcomes = { ...migrated.outcomes, ...run.outcomes }
  }
  own.add(run.losses, run.retries)
  if (!session) Object.assign(run.outcomes, own.commit())
  return run
}

/** Words for the gap row. The row carries the numbers; this is what a reader
 *  of the Timeline or an export sees without opening it. */
function describeLoss(loss: SpoolLoss): string {
  if (loss.reason === 'pause-end-unknown') {
    return `${loss.count} spooled event(s) not recorded: observed after a pause whose end was not recorded — recording may have resumed; content not kept`
  }
  const what = loss.reason === 'paused' ? 'observed while recording was paused'
    : loss.reason === 'terminal-not-recording' ? 'from a terminal that was not recording'
    : loss.reason === 'kind-not-allowed' ? 'named a kind the spool may not write'
    : loss.reason === 'malformed' ? 'could not be read'
    : loss.reason === 'legacy-bad' ? 'had been set aside as unreadable by an earlier version'
    : loss.reason === 'failed' ? 'could not be written, after repeated tries'
    : `(${loss.reason})`
  const notKept = loss.count - loss.kept
  const where = loss.intentional ? '' : loss.kept > 0 ? `; kept in ~/.redlog/pending/quarantine` : ''
  const lost = !loss.intentional && notKept > 0 ? `; content not kept for ${notKept} (quarantine full)` : ''
  const owner = loss.owners.unknown > 0 ? `; which project ${loss.owners.unknown} of them belonged to is unknown` : ''
  return `${loss.count} spooled event(s) not recorded: ${what}${where}${lost}${owner}`
}

/** Commit a chained `system.capture_gap` for one group of losses, at the time
 *  the first of them was observed so it stands in its place on the Timeline.
 *  False when the row is not there — refused, deduplicated or thrown — and the
 *  failure is reported where capture-write failures are. */
function recordLoss(loss: SpoolLoss, opening: SpoolDrainIdentity, part: { part: number; parts: number } | null): boolean {
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
        ...(loss.owners.unknown > 0 ? { by_owner: { this: loss.owners.this, unknown: loss.owners.unknown } } : {}),
        gap_started_at: loss.firstAt, gap_ended_at: loss.lastAt,
        files: loss.files.map((f) => f.name),
        ...(part ?? {}),
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
