import { getReadonlyDB } from './db/index'

/**
 * A point-in-time snapshot of both DB tiers' max rowid.
 * Preview and execute must share the same snapshot so the
 * dataset the operator reviewed is exactly the dataset exported.
 */
export interface ExportSnapshot {
  chainedMaxRowId: number
  loggedMaxRowId: number
  takenAt: number
}

export function takeExportSnapshot(): ExportSnapshot {
  const db = getReadonlyDB()
  const chained = db.prepare('SELECT MAX(rowid) AS m FROM events').get() as { m: number | null } | undefined
  const logged = db.prepare('SELECT MAX(rowid) AS m FROM events_logged').get() as { m: number | null } | undefined
  return {
    chainedMaxRowId: chained?.m ?? 0,
    loggedMaxRowId: logged?.m ?? 0,
    takenAt: Date.now()
  }
}
