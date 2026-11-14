// The stored half of the links between a command's rows, and between an HTTP
// flow's (Spec 071 SC-003, T032).
//
// causes-resolver.ts and ingest.ts hold those links in memory: a command_end
// finds its command_start there, a background job's late chunk finds its
// command, the target that command was filed under, and the chunk numbers
// already stored. Memory is the fast path and stays it. When it has nothing —
// the app restarted, or the entry was evicted — the answer is read here, from
// the rows themselves, by the key memory uses: the `command_id` string exactly
// as sent (the flow id for HTTP), within the open project. Each probe is one
// statement on a partial index, returning one row or the id's few starts and
// ends. The work inside it is one index step, except storedHighestSeq, which
// walks down the id's chunk numbers past those written before `after` or
// carrying neither flag: bounded by that id's chunk count, not the table's
// (measured on 268k rows: 0.04 ms usually, 14 ms for an id with 20,000
// unflagged chunks). ingest asks it once per rebuilt entry, then remembers.
//
// The two sides mean the same things: a flag is set only when it is the JSON
// `true` (memory tests `=== true`), and an id is an id only when it is a JSON
// string (memory tests `typeof … === 'string'`). SQLite uses a partial index
// only when the query's WHERE implies the index's, matching expressions by
// structure; the plan guard in test/stored-links.test.ts fails when a probe
// stops using its index.

import { getDB } from './index'

/** The newest round of one command. Rowids order rows as they were written,
 *  which is the order memory saw them in. Two ends, because memory reads two:
 *  the link is the first end's (a second end finds the command closed and
 *  changes nothing), the late-output target the last late end's (ingest files
 *  under every end that says a job keeps printing). With no start, every end
 *  of the id counts. */
export interface StoredCommand {
  start: { id: string; rowid: number; targetId: string | null } | null
  /** The first command_end after `start`. */
  firstEnd: { rowid: number; targetId: string | null; lateOutput: boolean } | null
  /** The newest command_end after `start` that declared late output. */
  lastLateEnd: { rowid: number; targetId: string | null } | null
}

/** The newest round of command `commandId` in the open project, or null when
 *  it has neither a start nor an end (or no project is open). */
export function storedCommand(commandId: string): StoredCommand | null {
  const db = openWriter()
  if (!db) return null
  // Sorted here, not by ORDER BY rowid: with that the planner prefers
  // idx_events_type and walks every shell row.
  const rows = db.prepare(`SELECT rowid AS r, id, subtype, target_id,
      (json_type(data, '$.late_output') = 'true' OR json_type(data, '$.output_streamed') = 'true') AS late
    FROM events WHERE agent_type = 'shell' AND json_extract(data, '$.command_id') = ? AND json_type(data, '$.command_id') = 'text'
      AND subtype IN ('command_start', 'command_end')`)
    .all(commandId) as Array<{ r: number; id: string; subtype: string; target_id: string | null; late: number }>
  if (rows.length === 0) return null
  rows.sort((a, b) => a.r - b.r)
  let start: (typeof rows)[number] | undefined
  let firstEnd: (typeof rows)[number] | undefined
  let lastLateEnd: (typeof rows)[number] | undefined
  for (const row of rows) {
    // In rowid order: an end before the newest start belongs to an earlier round.
    if (row.subtype === 'command_start') { start = row; firstEnd = undefined; lastLateEnd = undefined; continue }
    firstEnd ??= row
    if (row.late === 1) lastLateEnd = row
  }
  return {
    start: start ? { id: start.id, rowid: start.r, targetId: start.target_id } : null,
    firstEnd: firstEnd ? { rowid: firstEnd.r, targetId: firstEnd.target_id, lateOutput: firstEnd.late === 1 } : null,
    lastLateEnd: lastLateEnd ? { rowid: lastLateEnd.r, targetId: lastLateEnd.target_id } : null
  }
}

/** The rowid of the newest chunk of command `commandId` that said it was the
 *  last; null when there is none. One seek on a small index: only final chunks
 *  are in it. */
export function storedLastFinal(commandId: string): number | null {
  const db = openWriter()
  if (!db) return null
  const row = db.prepare(`SELECT rowid AS r FROM events
    WHERE agent_type = 'shell' AND subtype = 'command_output' AND json_type(data, '$.final') = 'true'
      AND json_extract(data, '$.command_id') = ? AND json_type(data, '$.command_id') = 'text'
    ORDER BY rowid DESC LIMIT 1`)
    .get(commandId) as { r: number } | undefined
  return row ? row.r : null
}

/** The highest chunk number of command `commandId` stored after rowid `after`,
 *  among the chunks ingest's resend check counts (`late` or `streamed`, a
 *  numeric `seq`), or null when there is none. */
export function storedHighestSeq(commandId: string, after: number): number | null {
  const db = openWriter()
  if (!db) return null
  // INDEXED BY: with `rowid > ?` in the WHERE the planner otherwise takes
  // idx_events_type and sorts every shell row after `after`.
  const row = db.prepare(`SELECT json_extract(data, '$.seq') AS seq FROM events INDEXED BY idx_events_shell_command
    WHERE agent_type = 'shell' AND json_extract(data, '$.command_id') = ? AND json_type(data, '$.command_id') = 'text'
      AND subtype = 'command_output' AND json_type(data, '$.seq') IN ('integer', 'real') AND rowid > ?
      AND (json_type(data, '$.late') = 'true' OR json_type(data, '$.streamed') = 'true')
    ORDER BY json_extract(data, '$.seq') DESC LIMIT 1`)
    .get(commandId, after) as { seq: number } | undefined
  return row ? row.seq : null
}

/** Whether chunk `seq` of command `commandId`, counted as above, is stored
 *  after rowid `after`. */
export function storedSeqSeen(commandId: string, seq: number, after: number): boolean {
  const db = openWriter()
  if (!db) return false
  return db.prepare(`SELECT 1 FROM events
    WHERE agent_type = 'shell' AND json_extract(data, '$.command_id') = ? AND json_type(data, '$.command_id') = 'text'
      AND subtype = 'command_output' AND json_extract(data, '$.seq') = ? AND json_type(data, '$.seq') IN ('integer', 'real') AND rowid > ?
      AND (json_type(data, '$.late') = 'true' OR json_type(data, '$.streamed') = 'true') LIMIT 1`)
    .get(commandId, seq, after) !== undefined
}

/** The http_request_start of flow `flowId` that no http_response has answered
 *  yet, or null. The same rule as the memory version: only a response closes a
 *  flow; an error or a drop leaves it open for a retry's response. */
export function storedOpenFlowStart(flowId: string): string | null {
  const db = openWriter()
  if (!db) return null
  const rows = db.prepare(`SELECT rowid AS r, id, subtype FROM events_logged
    WHERE agent_type = 'scanner' AND subtype IN ('http_request_start', 'http_response') AND json_extract(data, '$.flow_id') = ?
      AND json_type(data, '$.flow_id') = 'text'`)
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
