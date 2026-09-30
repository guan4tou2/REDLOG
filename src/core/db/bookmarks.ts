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
  /** The egress address, recorded only when the IP read was current. */
  externalIP?: string
  /** Set instead of `externalIP` when there was no current reading (a failed
   *  read, or air-gap mode): the last address read, and when (ms). */
  lastKnownExternalIP?: { address: string; readAt: number }
  lastCommand?: string
}

/** What the IP producer holds when a bookmark is made. */
export interface EgressReading {
  /** The last stable address. A failed read keeps it. */
  external: string | null
  /** The last read failed, or air-gap mode is on. */
  stale: boolean
  /** When a read last returned `external`; 0 before any did. */
  externalReadAt: number
}

/** The egress fields of a bookmark's auto-captured context.
 *
 *  A stale address is history, not the address in use, so it never goes in
 *  `externalIP`: every reader, this app's older builds and API clients
 *  included, takes that field as current. Keeping it, with its read time,
 *  rather than dropping it tells "not current" apart from "never read" and
 *  from a bookmark made without context (the API's). */
export function egressContext(reading: EgressReading): Pick<BookmarkContext, 'externalIP' | 'lastKnownExternalIP'> {
  if (!reading.external) return {}
  if (!reading.stale) return { externalIP: reading.external }
  return { lastKnownExternalIP: { address: reading.external, readAt: reading.externalReadAt } }
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

