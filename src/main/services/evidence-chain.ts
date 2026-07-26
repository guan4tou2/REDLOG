import crypto from 'crypto'
import { getDB } from '../db/index'

let lastHash = '0'.repeat(64)

export function initChain(): void {
  const db = getDB()
  const last = db.prepare('SELECT event_hash FROM chain ORDER BY seq DESC LIMIT 1').get() as { event_hash: string } | undefined
  if (last) lastHash = last.event_hash
}

export function appendToChain(eventId: string): void {
  const db = getDB()
  const eventRow = db.prepare('SELECT hash FROM events WHERE id = ?').get(eventId) as { hash: string } | undefined
  const eventHash = eventRow?.hash || ''

  const entryData = `${eventHash}:${lastHash}:${Date.now()}`
  const chainHash = crypto.createHash('sha256').update(entryData).digest('hex')

  db.prepare(
    'INSERT INTO chain (event_id, event_hash, prev_hash, timestamp) VALUES (?, ?, ?, ?)'
  ).run(eventId, chainHash, lastHash, Date.now())

  lastHash = chainHash
}

export function getChainLength(): number {
  const db = getDB()
  const row = db.prepare('SELECT COUNT(*) as count FROM chain').get() as { count: number }
  return row.count
}

export interface ChainVerifyResult {
  valid: boolean
  totalEntries: number
  breakAt: number | null
  details: string
}

export function verifyChain(): ChainVerifyResult {
  const db = getDB()
  const entries = db.prepare('SELECT seq, event_id, event_hash, prev_hash, timestamp FROM chain ORDER BY seq ASC').all() as Array<{
    seq: number; event_id: string; event_hash: string; prev_hash: string; timestamp: number
  }>

  if (entries.length === 0) {
    return { valid: true, totalEntries: 0, breakAt: null, details: 'Empty chain' }
  }

  if (entries[0].prev_hash !== '0'.repeat(64)) {
    return { valid: false, totalEntries: entries.length, breakAt: 1, details: 'First entry prev_hash is not genesis zero hash' }
  }

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].prev_hash !== entries[i - 1].event_hash) {
      return {
        valid: false,
        totalEntries: entries.length,
        breakAt: entries[i].seq,
        details: `Chain break at seq ${entries[i].seq}: prev_hash ${entries[i].prev_hash.slice(0, 16)}... does not match previous event_hash ${entries[i - 1].event_hash.slice(0, 16)}...`
      }
    }
  }

  return { valid: true, totalEntries: entries.length, breakAt: null, details: 'Chain intact' }
}
