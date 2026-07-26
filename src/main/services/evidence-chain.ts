import { getDB } from '../db/index'

export function initChain(): void {
  // no-op — table auto-created by initDB
}

export function appendToChain(eventId: string): void {
  const db = getDB()
  db.prepare('INSERT INTO chain (event_id, timestamp) VALUES (?, ?)').run(eventId, Date.now())
}

export function getChainLength(): number {
  const db = getDB()
  const row = db.prepare('SELECT COUNT(*) as count FROM chain').get() as { count: number }
  return row.count
}
