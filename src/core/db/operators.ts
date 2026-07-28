import crypto from 'crypto'
import { getDB } from './index'

export interface Operator {
  id: string
  name: string
  isPrimary: boolean
  createdAt: number
  revokedAt: number | null
}

interface OperatorRow {
  id: string
  name: string
  token_hash: string
  is_primary: number
  created_at: number
  revoked_at: number | null
}

function rowToOperator(row: OperatorRow): Operator {
  return {
    id: row.id,
    name: row.name,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export function slugifyOperatorId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'op'
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

export function createOperator(opts: {
  id: string
  name: string
  token: string
  isPrimary?: boolean
}): Operator {
  const db = getDB()
  const now = Date.now()
  db.prepare(
    `INSERT INTO operators (id, name, token_hash, is_primary, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(opts.id, opts.name, hashToken(opts.token), opts.isPrimary ? 1 : 0, now)
  return { id: opts.id, name: opts.name, isPrimary: !!opts.isPrimary, createdAt: now, revokedAt: null }
}

export function updateOperatorToken(id: string, token: string): boolean {
  const db = getDB()
  const info = db.prepare(
    `UPDATE operators SET token_hash = ?, revoked_at = NULL WHERE id = ?`
  ).run(hashToken(token), id)
  return info.changes > 0
}

export function renameOperator(id: string, name: string): boolean {
  const db = getDB()
  const info = db.prepare(`UPDATE operators SET name = ? WHERE id = ?`).run(name, id)
  return info.changes > 0
}

export function revokeOperator(id: string): boolean {
  const db = getDB()
  const info = db.prepare(
    `UPDATE operators SET revoked_at = ? WHERE id = ? AND is_primary = 0`
  ).run(Date.now(), id)
  return info.changes > 0
}

export function deleteOperator(id: string): boolean {
  const db = getDB()
  const info = db.prepare(`DELETE FROM operators WHERE id = ? AND is_primary = 0`).run(id)
  return info.changes > 0
}

export function listOperators(): Operator[] {
  const db = getDB()
  const rows = db.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators ORDER BY is_primary DESC, created_at ASC`
  ).all() as OperatorRow[]
  return rows.map(rowToOperator)
}

export function resolveOperatorByToken(token: string): Operator | null {
  if (!token) return null
  const db = getDB()
  const row = db.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators WHERE token_hash = ? AND revoked_at IS NULL`
  ).get(hashToken(token)) as OperatorRow | undefined
  return row ? rowToOperator(row) : null
}

export function getPrimaryOperator(): Operator | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators WHERE is_primary = 1 LIMIT 1`
  ).get() as OperatorRow | undefined
  return row ? rowToOperator(row) : null
}

export function ensurePrimaryOperator(id: string, name: string, token: string): Operator {
  const db = getDB()
  const existing = getPrimaryOperator()
  if (existing) {
    if (existing.id !== id || existing.name !== name) {
      db.prepare(`UPDATE operators SET id = ?, name = ? WHERE is_primary = 1`).run(id, name)
    }
    updateOperatorToken(id, token)
    return { ...existing, id, name }
  }
  return createOperator({ id, name, token, isPrimary: true })
}
