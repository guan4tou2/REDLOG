import { getReadonlyDB } from './index'
import type { ActivitySnapshot } from '../activity-contract'

export function readActivitySnapshot(db: ReturnType<typeof getReadonlyDB>, old?: ActivitySnapshot): ActivitySnapshot {
  if (old && (!Number.isSafeInteger(old.chainedMaxRowId) || old.chainedMaxRowId < 0 || !Number.isSafeInteger(old.loggedMaxRowId) || old.loggedMaxRowId < 0 || !Number.isFinite(old.takenAt))) throw new Error('Invalid Activity dataset snapshot')
  const read = (table: string, max?: number): { max: number; count: number; tail: string | null } => {
    const where = max == null ? '' : ' WHERE rowid <= ?'
    const row = db.prepare(`SELECT COALESCE(MAX(rowid),0) AS max,COUNT(*) AS count FROM ${table}${where}`).get(...(max == null ? [] : [max])) as { max: number; count: number }
    const tail = row.max ? (db.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(row.max) as { id: string }).id : null
    return { ...row, tail }
  }
  const chained = read('events', old?.chainedMaxRowId), logged = read('events_logged', old?.loggedMaxRowId)
  if (old && (chained.count !== old.chainedCount || logged.count !== old.loggedCount || chained.tail !== old.chainedTailId || logged.tail !== old.loggedTailId)) throw new Error('Activity dataset changed by retention; refresh the query')
  return old ?? { chainedMaxRowId: chained.max, loggedMaxRowId: logged.max, chainedCount: chained.count, loggedCount: logged.count, chainedTailId: chained.tail, loggedTailId: logged.tail, takenAt: Date.now() }
}
