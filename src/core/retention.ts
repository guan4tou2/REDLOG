// Retention sweeps for large per-project artifacts (.cast recordings +
// screenshot .jpg files). Runs once on project open. The DB event row
// stays regardless — only the on-disk file is deleted, and a
// `system.cast_pruned` / `system.screenshot_pruned` audit event is
// appended per deletion so the chain records that raw evidence was
// removed by policy (as opposed to silently disappearing).
//
// v0.6.87 B1 + B2.

import fs from 'fs'
import path from 'path'
import { getProjectDir, getDB } from './db/index'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'

// v0.6.89 `_causes`: cast_pruned and screenshot_pruned should reference the
// upstream event so focus chain walks light up the "originally recorded here
// → later pruned by retention" arc. For casts we can look up the session_end
// event whose data.castPath matches the file we're deleting; for screenshots
// the .jpg filename is chosen at capture time, so we look up the screenshot
// event by its data.filename basename.
function lookupCauseEventId(subtype: 'cast_pruned' | 'screenshot_pruned', absPath: string): string | null {
  try {
    const db = getDB()
    const basename = path.basename(absPath)
    if (subtype === 'cast_pruned') {
      const row = db.prepare(`
        SELECT id FROM events
        WHERE agent_type = 'shell'
          AND json_extract(data,'$.subtype') = 'session_end'
          AND json_extract(data,'$.castPath') = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(absPath) as { id: string } | undefined
      return row?.id ?? null
    }
    // screenshot_pruned: the screenshot event stores `filename` (basename only)
    // and `filePath` (absolute). Match on either — some old rows only have one.
    const row = db.prepare(`
      SELECT id FROM events
      WHERE agent_type = 'screenshot'
        AND (json_extract(data,'$.filePath') = ? OR json_extract(data,'$.filename') = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(absPath, basename) as { id: string } | undefined
    return row?.id ?? null
  } catch { return null }
}

const DAY_MS = 24 * 60 * 60 * 1000

function sweepDir(
  dir: string,
  keepDays: number,
  matcher: (name: string) => boolean,
  auditSubtype: string,
  opts: { engagementId: string; operatorId: string }
): number {
  if (keepDays <= 0) return 0
  if (!fs.existsSync(dir)) return 0
  const cutoff = Date.now() - keepDays * DAY_MS
  let pruned = 0
  let entries: string[] = []
  try { entries = fs.readdirSync(dir) } catch { return 0 }
  for (const name of entries) {
    if (!matcher(name)) continue
    const full = path.join(dir, name)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }
    if (stat.mtimeMs > cutoff) continue
    // v0.6.89: resolve the upstream event id BEFORE deletion so the audit
    // event points at the original recording/screenshot row for focus chain.
    const causeId = (auditSubtype === 'cast_pruned' || auditSubtype === 'screenshot_pruned')
      ? lookupCauseEventId(auditSubtype, full)
      : null
    try {
      fs.unlinkSync(full)
      pruned++
      try {
        const ev = insertEvent('system', {
          subtype: auditSubtype,
          path: full,
          bytes: stat.size,
          ageDays: Math.round((Date.now() - stat.mtimeMs) / DAY_MS),
          description: `pruned by retention policy (${keepDays}d)`,
          ...(causeId ? { _causes: [causeId] } : {})
        }, opts)
        if (ev) eventBus.publish(ev)
      } catch (e) { noteDbError('retention-sweep', e) }
    } catch { /* file gone / permission — skip */ }
  }
  return pruned
}

/** v0.13.0 (docs/DESIGN-logged-tier-retention.md): row-level sweep of the
 *  events_logged table. Age-based delete keyed on `created_at`
 *  (clock-drift-immune; see design §5.2). Fires one chained
 *  `system.retention_pruned_logged` summary event when count > 0
 *  (mirrors the cast_pruned non-empty convention). Respects
 *  `eventBus.paused` for symmetry with insertEvent. */
export interface LoggedTierRetentionResult {
  deleted: number
  bytesFreed: number
  oldestPruned: number | null
  newestPruned: number | null
  durationMs: number
}

const BATCH_SIZE = 5000  // §5.3: large deletes are batched so a 40 GB
                         // sweep doesn't stall WAL for minutes.

export function sweepLoggedTier(
  cfg: { keepDays?: number } | undefined,
  opts: { engagementId: string; operatorId: string }
): LoggedTierRetentionResult {
  const noop = { deleted: 0, bytesFreed: 0, oldestPruned: null, newestPruned: null, durationMs: 0 }
  if (!opts.operatorId) return noop
  // §5.4: sweep respects eventBus.paused for symmetry with insertEvent —
  // a paused RedLog does NOT prune. Recording resumes → next timer tick
  // catches up.
  if (eventBus.paused) return noop
  // Env var override for CI / air-gapped installs (design §4.3).
  // Guard the empty-string case: `Number('') === 0` would otherwise pass
  // Number.isFinite && >= 0 and silently switch to keep-forever, exactly
  // the silent-typo-vaporises-tier failure §7.2 wanted to avoid.
  const envRaw = process.env.REDLOG_LOGGED_RETENTION_DAYS
  const envDays = envRaw && envRaw.length > 0 ? Number(envRaw) : NaN
  const keepDays = Number.isFinite(envDays) && envDays >= 0
    ? envDays
    : (cfg?.keepDays ?? 30)
  if (keepDays <= 0) return noop  // 0 = keep forever (opt-out)

  const cutoff = Date.now() - keepDays * DAY_MS
  const started = Date.now()
  let db
  try { db = getDB() } catch { return noop }

  // Bounds first — for the summary event.
  const bounds = db.prepare(
    'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM events_logged WHERE created_at < ?'
  ).get(cutoff) as { oldest: number | null; newest: number | null }
  if (bounds.oldest === null) return noop  // nothing to prune

  // Byte estimate before delete — pages freed is approximate but useful.
  // The `data` blob is the dominant weight; sum its length.
  const bytesRow = db.prepare(
    'SELECT COALESCE(SUM(LENGTH(data)), 0) as bytes FROM events_logged WHERE created_at < ?'
  ).get(cutoff) as { bytes: number }
  const bytesFreed = bytesRow.bytes

  // Batched delete. `changes()` gives us the per-statement count so we
  // can loop until the affected set is empty (or bounded — no infinite
  // loops on a stuck row).
  let deleted = 0
  const stmt = db.prepare(
    `DELETE FROM events_logged WHERE rowid IN (
       SELECT rowid FROM events_logged WHERE created_at < ? LIMIT ${BATCH_SIZE}
     )`
  )
  for (let iterations = 0; iterations < 10_000; iterations++) {
    const info = stmt.run(cutoff)
    const batchDeleted = Number(info.changes ?? 0)
    if (batchDeleted === 0) break
    deleted += batchDeleted
  }
  if (deleted === 0) return noop

  const durationMs = Date.now() - started
  try {
    const ev = insertEvent('system', {
      subtype: 'retention_pruned_logged',
      count: deleted,
      bytes_freed: bytesFreed,
      oldest_pruned_at: bounds.oldest,
      newest_pruned_at: bounds.newest,
      keep_days: keepDays,
      sweep_duration_ms: durationMs,
      description: `retention: pruned ${deleted} logged-tier row(s), freed ~${Math.round(bytesFreed / 1024 / 1024)} MB (${keepDays}d policy)`
    }, opts)
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('retention-sweep-logged', e) }

  return {
    deleted,
    bytesFreed,
    oldestPruned: bounds.oldest,
    newestPruned: bounds.newest,
    durationMs
  }
}

export function sweepRetention(config: {
  terminal?: { castKeepDays?: number }
  screenshots?: { keepDays?: number }
  agentTranscripts?: { keepDays?: number }
}, opts: { engagementId: string; operatorId: string }): { cast: number; screenshots: number; agentTranscripts: number } {
  if (!opts.operatorId) return { cast: 0, screenshots: 0, agentTranscripts: 0 }
  let projectDir: string
  try { projectDir = getProjectDir() } catch { return { cast: 0, screenshots: 0, agentTranscripts: 0 } }
  const castDays = config.terminal?.castKeepDays ?? 0
  const shotDays = config.screenshots?.keepDays ?? 0
  // v0.7.2 F: agent-transcripts sweep.
  // v0.7.4 F2: default changed from 30 to 0 (keep forever unless opted in),
  // matching cast + screenshot conventions. Code-review adversarial pass
  // caught that pruning a sidecar whose Claude Code source .jsonl still
  // exists caused every historical turn to be re-inserted as fresh chained
  // events on next project open — because the tailer used sidecar size as
  // its sole "how far have we processed" marker. That specific corruption
  // path is now closed by the F2 DB-side seed of `redlogIdByUuid` at
  // registerSession (which dedups even if the sidecar was reset), but
  // matching sibling conventions removes the surprise for operators who
  // expected evidence to be kept by default.
  const agentDays = config.agentTranscripts?.keepDays ?? 0
  const cast = sweepDir(
    path.join(projectDir, 'casts'),
    castDays,
    (n) => n.endsWith('.cast'),
    'cast_pruned',
    opts
  )
  const screenshots = sweepDir(
    path.join(projectDir, 'screenshots'),
    shotDays,
    (n) => /\.(jpg|jpeg|png)$/i.test(n),
    'screenshot_pruned',
    opts
  )
  const agentTranscripts = sweepDir(
    path.join(projectDir, 'agent-transcripts'),
    agentDays,
    (n) => n.endsWith('.jsonl'),
    'agent_transcript_pruned',
    opts
  )
  return { cast, screenshots, agentTranscripts }
}
