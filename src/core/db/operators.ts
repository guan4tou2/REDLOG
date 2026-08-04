import crypto from 'crypto'
import { getDB } from './index'
import { generateOperatorKeyPair } from '../signing'

export interface Operator {
  id: string
  name: string
  isPrimary: boolean
  createdAt: number
  revokedAt: number | null
  signerPubKey: string | null
}

interface OperatorRow {
  id: string
  name: string
  token_hash: string
  is_primary: number
  created_at: number
  revoked_at: number | null
  signer_pub_key: string | null
}

function rowToOperator(row: OperatorRow): Operator {
  return {
    id: row.id,
    name: row.name,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    signerPubKey: row.signer_pub_key ?? null
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
  // v0.6.89: mint a signing keypair alongside the operator. Public key is
  // mirrored into the DB so verify never touches disk to walk history.
  // Failures (permissions, no home dir writable) degrade to an unsigned
  // operator — the audit chain hash still protects events, and
  // verifyChainFull reports "unsigned" rather than "broken".
  let signerPubKey: string | null = null
  try {
    const kp = generateOperatorKeyPair(opts.id)
    signerPubKey = kp.publicKey
    db.prepare(`UPDATE operators SET signer_pub_key = ? WHERE id = ?`).run(signerPubKey, opts.id)
  } catch { /* leave signer_pub_key NULL — operator remains functional, just unsigned */ }
  return {
    id: opts.id, name: opts.name, isPrimary: !!opts.isPrimary,
    createdAt: now, revokedAt: null, signerPubKey
  }
}

export function updateOperatorToken(id: string, token: string): boolean {
  const db = getDB()
  const info = db.prepare(
    `UPDATE operators SET token_hash = ?, revoked_at = NULL WHERE id = ?`
  ).run(hashToken(token), id)
  // v0.6.89: token rotation is NOT signing-key rotation. Token != identity —
  // it's the HTTP auth cookie for the local API server; the signing key is
  // the operator's cryptographic identity. Rotating the signing key would
  // invalidate every past-signed event for this operator (no way to re-sign
  // history without also re-hashing, which breaks the chain), so key rotation
  // needs its own IPC + a supersedes-relation design. Punted from v0.6.89.
  //
  // We DO backfill a signing key if the operator was created pre-v0.6.89 and
  // has no key yet — token rotation is a natural "operator touched their
  // account" moment, so opting them into signing here is low-surprise.
  if (info.changes > 0) {
    try {
      const existing = db.prepare(`SELECT signer_pub_key FROM operators WHERE id = ?`).get(id) as { signer_pub_key: string | null } | undefined
      if (existing && !existing.signer_pub_key) {
        const kp = generateOperatorKeyPair(id)
        db.prepare(`UPDATE operators SET signer_pub_key = ? WHERE id = ?`).run(kp.publicKey, id)
      }
    } catch { /* best effort */ }
  }
  return info.changes > 0
}

// v0.6.89: read the operator's public signing key without touching disk.
// verifyChainFull calls this once per row (cheap — small operator set); the
// DB copy is authoritative for chain verification.
export function getOperatorSignerPubKey(id: string): string | null {
  const db = getDB()
  const row = db.prepare(`SELECT signer_pub_key FROM operators WHERE id = ?`).get(id) as { signer_pub_key: string | null } | undefined
  return row?.signer_pub_key ?? null
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
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at, signer_pub_key
     FROM operators ORDER BY is_primary DESC, created_at ASC`
  ).all() as OperatorRow[]
  return rows.map(rowToOperator)
}

export function resolveOperatorByToken(token: string): Operator | null {
  if (!token) return null
  const db = getDB()
  const row = db.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at, signer_pub_key
     FROM operators WHERE token_hash = ? AND revoked_at IS NULL`
  ).get(hashToken(token)) as OperatorRow | undefined
  return row ? rowToOperator(row) : null
}

export function getPrimaryOperator(): Operator | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at, signer_pub_key
     FROM operators WHERE is_primary = 1 LIMIT 1`
  ).get() as OperatorRow | undefined
  return row ? rowToOperator(row) : null
}

export function getPrimaryOperatorTokenHash(): string | null {
  const db = getDB()
  const row = db.prepare(
    `SELECT token_hash FROM operators WHERE is_primary = 1 LIMIT 1`
  ).get() as { token_hash: string } | undefined
  return row?.token_hash ?? null
}

export function ensurePrimaryOperator(id: string, name: string, token: string): Operator {
  const db = getDB()
  const existing = getPrimaryOperator()
  if (existing) {
    if (existing.id !== id || existing.name !== name) {
      db.prepare(`UPDATE operators SET id = ?, name = ? WHERE is_primary = 1`).run(id, name)
    }
    updateOperatorToken(id, token) // also backfills signer_pub_key if missing
    // Re-read: updateOperatorToken may have minted a signing key just now.
    const refreshed = getPrimaryOperator()
    return refreshed ?? { ...existing, id, name }
  }
  return createOperator({ id, name, token, isPrimary: true })
}
