import crypto from 'crypto'
import { getDB } from './index'

export interface Bookmark {
  id: string
  title: string
  url: string | null
  note: string
  context: BookmarkContext
  createdAt: number
}

export interface BookmarkContext {
  browserUrl?: string
  browserTitle?: string
  externalIP?: string
  lastCommand?: string
}

function rowToBookmark(row: Record<string, unknown>): Bookmark {
  return {
    id: row.id as string,
    title: row.title as string,
    url: row.url as string | null,
    note: row.note as string,
    context: JSON.parse((row.context as string) || '{}'),
    createdAt: row.created_at as number
  }
}

export function createBookmark(data: {
  title: string
  url?: string
  note?: string
  context?: BookmarkContext
}): Bookmark {
  const db = getDB()
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO bookmarks (id, title, url, note, context, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, data.title, data.url || null, data.note || '', JSON.stringify(data.context || {}), now)
  return { id, title: data.title, url: data.url || null, note: data.note || '', context: data.context || {}, createdAt: now }
}

export function listBookmarks(): Bookmark[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all()
  return rows.map((r) => rowToBookmark(r as Record<string, unknown>))
}

export function getBookmark(id: string): Bookmark | null {
  const db = getDB()
  const row = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id)
  return row ? rowToBookmark(row as Record<string, unknown>) : null
}

export function updateBookmark(id: string, data: { title?: string; url?: string; note?: string }): Bookmark | null {
  const db = getDB()
  const existing = getBookmark(id)
  if (!existing) return null
  const title = data.title ?? existing.title
  const url = data.url ?? existing.url
  const note = data.note ?? existing.note
  db.prepare('UPDATE bookmarks SET title = ?, url = ?, note = ? WHERE id = ?').run(title, url, note, id)
  return { ...existing, title, url, note }
}

export function deleteBookmark(id: string): boolean {
  const db = getDB()
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  return result.changes > 0
}

/** Retention: delete bookmarks created before `cutoffMs`. Returns the count.
 *  The bookmarks table is not chained, so this is a plain DELETE — the
 *  audit trail is the `system.bookmarks_pruned` row the caller appends. */
export function deleteBookmarksOlderThan(cutoffMs: number): number {
  const db = getDB()
  const result = db.prepare('DELETE FROM bookmarks WHERE created_at < ?').run(cutoffMs)
  return result.changes
}

