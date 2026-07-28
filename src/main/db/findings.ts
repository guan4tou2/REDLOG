import crypto from 'crypto'
import { getDB } from './index'

export interface QuickMark {
  id: string
  title: string
  url: string | null
  note: string
  context: QuickMarkContext
  createdAt: number
}

export interface QuickMarkContext {
  browserUrl?: string
  browserTitle?: string
  externalIP?: string
  lastCommand?: string
}

function rowToQuickMark(row: Record<string, unknown>): QuickMark {
  return {
    id: row.id as string,
    title: row.title as string,
    url: row.url as string | null,
    note: row.note as string,
    context: JSON.parse((row.context as string) || '{}'),
    createdAt: row.created_at as number
  }
}

export function createQuickMark(data: {
  title: string
  url?: string
  note?: string
  context?: QuickMarkContext
}): QuickMark {
  const db = getDB()
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO quickmarks (id, title, url, note, context, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, data.title, data.url || null, data.note || '', JSON.stringify(data.context || {}), now)
  return { id, title: data.title, url: data.url || null, note: data.note || '', context: data.context || {}, createdAt: now }
}

export function listQuickMarks(): QuickMark[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM quickmarks ORDER BY created_at DESC').all()
  return rows.map((r) => rowToQuickMark(r as Record<string, unknown>))
}

export function getQuickMark(id: string): QuickMark | null {
  const db = getDB()
  const row = db.prepare('SELECT * FROM quickmarks WHERE id = ?').get(id)
  return row ? rowToQuickMark(row as Record<string, unknown>) : null
}

export function updateQuickMark(id: string, data: { title?: string; url?: string; note?: string }): QuickMark | null {
  const db = getDB()
  const existing = getQuickMark(id)
  if (!existing) return null
  const title = data.title ?? existing.title
  const url = data.url ?? existing.url
  const note = data.note ?? existing.note
  db.prepare('UPDATE quickmarks SET title = ?, url = ?, note = ? WHERE id = ?').run(title, url, note, id)
  return { ...existing, title, url, note }
}

export function deleteQuickMark(id: string): boolean {
  const db = getDB()
  const result = db.prepare('DELETE FROM quickmarks WHERE id = ?').run(id)
  return result.changes > 0
}

