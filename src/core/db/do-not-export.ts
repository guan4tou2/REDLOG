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

export function getDoNotExportIds(): Set<string> {
  const rows = getReadonlyDB().prepare('SELECT event_id FROM do_not_export').all() as Array<{ event_id: string }>
  return new Set(rows.map(r => r.event_id))
}
