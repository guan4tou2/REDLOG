import crypto from 'crypto'
import { getDB } from '../db/index'

let lastHash = '0'.repeat(64)

export function initChain(): void {
  const db = getDB()
  const row = db.prepare('SELECT event_hash FROM chain ORDER BY seq DESC LIMIT 1').get() as { event_hash: string } | undefined
  if (row) lastHash = row.event_hash
}

export function appendToChain(eventId: string, eventData: string): void {
  const db = getDB()
  const eventHash = crypto.createHash('sha256').update(eventData).digest('hex')

  db.prepare(`
    INSERT INTO chain (event_id, event_hash, prev_hash, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(eventId, eventHash, lastHash, Date.now())

  lastHash = eventHash
}

export function verifyChain(): { valid: boolean; entries: number; firstBreak: number | null } {
  const db = getDB()
  const rows = db.prepare('SELECT seq, event_id, event_hash, prev_hash FROM chain ORDER BY seq ASC').all() as Array<{
    seq: number; event_id: string; event_hash: string; prev_hash: string
  }>

  if (rows.length === 0) return { valid: true, entries: 0, firstBreak: null }

  let prevHash = '0'.repeat(64)
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return { valid: false, entries: rows.length, firstBreak: row.seq }
    }
    prevHash = row.event_hash
  }

  return { valid: true, entries: rows.length, firstBreak: null }
}

export function getChainLength(): number {
  const db = getDB()
  const row = db.prepare('SELECT COUNT(*) as count FROM chain').get() as { count: number }
  return row.count
}
