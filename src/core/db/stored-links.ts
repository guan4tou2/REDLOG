// The stored half of the links between a command's rows, and between an HTTP
// flow's (Spec 071 SC-003, T032).
//
// causes-resolver.ts and ingest.ts hold those links in memory: a command_end
// finds its command_start there, a background job's late chunk finds its
// command and the target that command was filed under. Memory is the fast
// path and stays it. When it has nothing — the app restarted between a
// command's start and its end, or between the end and the job's output — the
// answer is read here, from the rows themselves, by the same identity the
// memory version keys on: the command id (or the flow id) within the open
// project. A miss is a seek on an index; a hit never reaches this module.
//
// Each probe repeats its index's WHERE terms and expressions character for
// character (db/index.ts), since SQLite uses a partial index only then; the
// plan guard in test/stored-links.test.ts fails when they drift.

import { getDB } from './index'

/** What the project's rows say about one command, by its id. Rowids order the
 *  rows as they were written, which is the order the memory version saw them. */
export interface StoredCommand {
  /** The newest command_start with this id. */
  start: { id: string; targetId: string | null } | null
  /** The newest command_end written after that start (any, when there is no start). */
  end: { targetId: string | null; lateOutput: boolean } | null
  /** A chunk of this command said it was the last. */
  finalSeen: boolean
  /** The chunk numbers already stored for it, as ingest's resend check counts them. */
  seqs: number[]
}

/** The rows of command `commandId` in the open project, or null when it has none
 *  (or no project is open). Chunks of a command whose start and end were never
 *  stored still count: their numbers are what a resend is checked against.
 *  `withChunks: false` skips the chunk summary, which only a chunk needs. */
export function storedCommand(commandId: string, withChunks: boolean): StoredCommand | null {
  const db = openWriter()
  if (!db) return null
  // Sorted here, not by ORDER BY rowid: with that the planner prefers
  // idx_events_type and walks every shell row.
  const rows = db.prepare(`SELECT rowid AS r, id, subtype, target_id,
      (json_extract(data, '$.late_output') = 1 OR json_extract(data, '$.output_streamed') = 1) AS late
    FROM events WHERE agent_type = 'shell' AND json_extract(data, '$.command_id') = ? AND subtype IN ('command_start', 'command_end')`)
    .all(commandId) as Array<{ r: number; id: string; subtype: string; target_id: string | null; late: number | null }>
  if (rows.length === 0 && !withChunks) return null
  rows.sort((a, b) => a.r - b.r)
  let lastStart: (typeof rows)[number] | undefined
  let lastEnd: (typeof rows)[number] | undefined
  for (const row of rows) {
    // In rowid order: an end before the newest start belongs to an earlier run.
    if (row.subtype === 'command_start') { lastStart = row; lastEnd = undefined } else lastEnd = row
  }
  let finalSeen = false
  let seqs: number[] = []
  if (withChunks) {
    const chunks = db.prepare(`SELECT COUNT(*) AS n, MAX(json_extract(data, '$.final') = 1) AS final,
        json_group_array(json_extract(data, '$.seq')) FILTER (WHERE (json_extract(data, '$.late') = 1 OR json_extract(data, '$.streamed') = 1)
          AND json_type(data, '$.seq') IN ('integer', 'real')) AS seqs
      FROM events WHERE agent_type = 'shell' AND json_extract(data, '$.command_id') = ? AND subtype = 'command_output'`)
      .get(commandId) as { n: number; final: number | null; seqs: string }
    if (rows.length === 0 && chunks.n === 0) return null
    finalSeen = chunks.final === 1
    seqs = JSON.parse(chunks.seqs) as number[]
  }
  return {
    start: lastStart ? { id: lastStart.id, targetId: lastStart.target_id } : null,
    end: lastEnd ? { targetId: lastEnd.target_id, lateOutput: lastEnd.late === 1 } : null,
    finalSeen,
    seqs
  }
}

/** The http_request_start of flow `flowId` that no http_response has answered
 *  yet, or null. The same rule as the memory version: only a response closes a
 *  flow; an error or a drop leaves it open for a retry's response. */
export function storedOpenFlowStart(flowId: string): string | null {
  const db = openWriter()
  if (!db) return null
  const rows = db.prepare(`SELECT rowid AS r, id, subtype FROM events_logged
    WHERE agent_type = 'scanner' AND subtype IN ('http_request_start', 'http_response') AND json_extract(data, '$.flow_id') = ?`)
    .all(flowId) as Array<{ r: number; id: string; subtype: string }>
  let start: { r: number; id: string } | null = null
  let answered = -1
  for (const row of rows) {
    if (row.subtype === 'http_request_start') { if (!start || row.r > start.r) start = row }
    else if (row.r > answered) answered = row.r
  }
  return start && answered < start.r ? start.id : null
}

/** The connection ingest writes through: the rows it asks about are the ones
 *  it has just written. Null when no project is open — nothing to find. */
function openWriter(): ReturnType<typeof getDB> | null {
  try { return getDB() } catch { return null }
}
