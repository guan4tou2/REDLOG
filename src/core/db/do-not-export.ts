import { getDB, getReadonlyDB } from './index'

export function toggleDoNotExport(eventId: string): boolean {
  const db = getDB()
  const exists = db.prepare('SELECT 1 FROM do_not_export WHERE event_id = ?').get(eventId)
  if (exists) {
    db.prepare('DELETE FROM do_not_export WHERE event_id = ?').run(eventId)
    return false
  }
  db.prepare('INSERT INTO do_not_export (event_id, created_at) VALUES (?, ?)').run(eventId, Date.now())
  return true
}

export function isDoNotExport(eventId: string): boolean {
  return !!getReadonlyDB().prepare('SELECT 1 FROM do_not_export WHERE event_id = ?').get(eventId)
}

/** Rows the operator marked, and the background output of any marked command.
 *  That output is rows of its own, with ids nobody flagged; leaving them out of
 *  this set would export the very text the operator kept out. */
export function getDoNotExportIds(): Set<string> {
  const db = getReadonlyDB()
  const rows = db.prepare('SELECT event_id FROM do_not_export').all() as Array<{ event_id: string }>
  const ids = new Set(rows.map(r => r.event_id))
  for (const { event_id } of rows) {
    for (const table of ['events', 'events_logged']) {
      const end = db.prepare(
        `SELECT json_extract(data, '$.command_id') AS c FROM ${table}
          WHERE id = ? AND agent_type = 'shell' AND subtype = 'command_end'
            AND (json_extract(data, '$.late_output') = 1 OR json_extract(data, '$.output_streamed') = 1)`
      ).get(event_id) as { c: string | null } | undefined
      if (!end?.c) continue
      for (const t of ['events', 'events_logged']) {
        const chunks = db.prepare(
          `SELECT id FROM ${t} WHERE agent_type = 'shell' AND subtype = 'command_output'
             AND json_extract(data, '$.command_id') = ? AND (json_extract(data, '$.late') = 1 OR json_extract(data, '$.streamed') = 1)`
        ).all(end.c) as Array<{ id: string }>
        for (const c of chunks) ids.add(c.id)
      }
    }
  }
  return ids
}
