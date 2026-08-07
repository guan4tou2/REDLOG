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
  // v0.7.2 F: agent-transcripts sweep. Default 30d if unset — long enough
  // for an operator to reference back to a prior week's session but bounded
  // so a light-usage engagement doesn't slowly accumulate GB of Claude Code
  // conversation history. Same audit-append pattern as cast/screenshot:
  // the file is unlinked and a `system.agent_transcript_pruned` event
  // records the deletion (bytes + age).
  const agentDays = config.agentTranscripts?.keepDays ?? 30
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
