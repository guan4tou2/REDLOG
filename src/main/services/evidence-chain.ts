import { getDB } from '../db/index'

export function getChainLength(): number {
  const db = getDB()
  const row = db.prepare('SELECT COUNT(*) as count FROM events WHERE hash IS NOT NULL').get() as { count: number }
  return row.count
}
