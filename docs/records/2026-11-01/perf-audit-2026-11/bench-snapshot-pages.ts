// Page cost down a snapshot read — the loop `iterateSnapshotEvents` runs for a
// whole-project export (512-row pages, both tiers, newest first).
//
//   node docs/records/2026-11-01/perf-audit-2026-11/run.mjs bench-snapshot-pages.ts -- <projectDir>
//
// Prints the time of every 25th page, so a cost that grows with depth shows as
// a slope and a constant cost shows as a flat line.

import { initDB } from '../../../../src/core/db/index'
import { queryEventsPage } from '../../../../src/core/db/event-queries'
import { takeExportSnapshot } from '../../../../src/core/export-plan'

const [projectDir] = process.argv.slice(2)
initDB(projectDir)
const snapshot = takeExportSnapshot()
let cursor: string | null = null
let page = 0
let rows = 0
const t0 = performance.now()
const marks: Array<{ page: number; rows: number; ms: number }> = []
do {
  const s = performance.now()
  const r = queryEventsPage({ snapshot, cursor, limit: 512 })
  const ms = performance.now() - s
  rows += r.items.length
  page++
  if (page === 1 || page % 25 === 0) marks.push({ page, rows, ms: Math.round(ms) })
  cursor = r.hasMore ? r.nextCursor : null
} while (cursor)
console.log(JSON.stringify({ pages: page, rows, totalMs: Math.round(performance.now() - t0), marks }))
