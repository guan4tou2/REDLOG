import { getDB, getReadonlyDB } from './index'

// What the operator made of one event.
//
// The event says what happened. A note says what they concluded, or meant to
// come back to — "this 404 is the interesting one", "ran this twice by
// mistake". It lives in a side table for the same reason do_not_export does:
// events rows are immutable and hashed, and a note written an hour later must
// not change the row it is about, or the chain stops verifying.
//
// It is an annotation and never evidence, which is why it carries its own
// timestamps: a reader can see it was written after the fact, and when.

export interface EventNote {
  note: string
  createdAt: number
  updatedAt: number
}

/** Write, or clear. Empty (or whitespace-only) text deletes the row: a note
 *  the operator cleared should leave nothing behind rather than an empty one,
 *  which would read as "they looked and had nothing to say". */
export function setEventNote(eventId: string, note: string): EventNote | null {
  const text = note.trim()
  const db = getDB()
  if (!text) {
    db.prepare('DELETE FROM event_notes WHERE event_id = ?').run(eventId)
    return null
  }
  const now = Date.now()
  // `created_at` survives an edit — how long this has been annotated is a
  // different fact from when it was last reworded.
  db.prepare(
    `INSERT INTO event_notes (event_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
  ).run(eventId, text, now, now)
  return getEventNote(eventId)
}

export function getEventNote(eventId: string): EventNote | null {
  const row = getReadonlyDB()
    .prepare('SELECT note, created_at, updated_at FROM event_notes WHERE event_id = ?')
    .get(eventId) as { note: string; created_at: number; updated_at: number } | undefined
  return row ? { note: row.note, createdAt: row.created_at, updatedAt: row.updated_at } : null
}

/** Every annotated event id, for marking them in a list without a query per row. */
export function getAnnotatedIds(): Set<string> {
  const rows = getReadonlyDB().prepare('SELECT event_id FROM event_notes').all() as Array<{ event_id: string }>
  return new Set(rows.map((r) => r.event_id))
}
