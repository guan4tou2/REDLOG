// Seed a large project — PERF-AUDIT-2026-11 §2 and §4.
//
//   PERF_HOME=<app home> node docs/perf-audit-2026-11/run.mjs seed-project.ts -- <projectDir> <cycles> [fidelity]
//
// The project is one the app created (so its config, operator and key are the
// app's own); PERF_HOME points the runner at that home so rows are signed with
// the operator's real key.
//
// fidelity
//   rows  (default) insertEvent() directly: every row hashed, signed and
//         tiered exactly as ingest would store it, with the target ingest
//         would have extracted. HTTP bodies are left out of the rows (in
//         production they are moved to sidecar files); everything else is the
//         workload's payload. ~5 days of activity, oldest first.
//   full  ingest() for every row — bodies to sidecars, body index, loot scan,
//         companions — at whatever speed ingest manages (§3).

import { initDB, getDB, closeDB } from '../../src/core/db/index'
import { insertEvent } from '../../src/core/db/event-write'
import { configureIngest, ingest } from '../../src/core/ingest'
import { LootDetector } from '../../src/core/loot-detector'
import { getPrimaryOperator } from '../../src/core/db/operators'
import { cycle } from './workload'

const [projectDir, cyclesArg = '18000', fidelity = 'rows'] = process.argv.slice(2)
if (!projectDir) { console.error('usage: seed-project.ts <projectDir> <cycles> [rows|full]'); process.exit(2) }
const CYCLES = Number(cyclesArg)
const SPAN_MS = 5 * 24 * 3600 * 1000

initDB(projectDir)
const op = getPrimaryOperator()
if (!op) throw new Error('no primary operator: open the project in the app once first')
const db = getDB()
const engagementId = (db.prepare(`SELECT engagement_id FROM events ORDER BY rowid LIMIT 1`).get() as { engagement_id: string } | undefined)?.engagement_id
if (!engagementId) throw new Error('project has no genesis row: open it in the app once first')

const loot = new LootDetector()
loot.configure({ engagementId, operatorId: op.id })
if (fidelity === 'full') configureIngest({ lootDetector: loot })

const start = Date.now() - SPAN_MS
const hostOf = (data: Record<string, unknown>): string | undefined =>
  typeof data.host === 'string' ? data.host : undefined

const t0 = performance.now()
let rows = 0
const BATCH = 200
for (let from = 0; from < CYCLES; from += BATCH) {
  const to = Math.min(CYCLES, from + BATCH)
  const run = (): void => {
    for (let i = from; i < to; i++) {
      const occurredAt = start + Math.floor((i / CYCLES) * SPAN_MS)
      cycle(i).forEach((ev, k) => {
        const at = occurredAt + k * 150
        if (fidelity === 'full') {
          const r = ingest({ agentType: ev.agentType, data: ev.data, operatorId: op.id, engagementId, occurredAt: at,
            envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
          if (r.event) rows += 1 + r.companions.length
          return
        }
        const data = { ...ev.data }
        delete data.response_body
        delete data.request_body
        const cmd = typeof data.command === 'string' ? data.command : ''
        const target = hostOf(data) ?? cmd.match(/\d+\.\d+\.\d+\.\d+|[a-z0-9.-]+\.(?:local|com)/)?.[0]
        if (insertEvent(ev.agentType, data, { engagementId, operatorId: op.id, targetId: target, occurredAt: at })) rows++
      })
    }
  }
  // `full` is left to ingest's own commits, as in production.
  if (fidelity === 'full') run(); else db.transaction(run)()
  if ((to / BATCH) % 10 === 0 || to === CYCLES) {
    console.log(JSON.stringify({ cycles: to, rows, seconds: +((performance.now() - t0) / 1000).toFixed(1) }))
  }
}
const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM events) AS chained, (SELECT COUNT(*) FROM events_logged) AS logged`).get()
console.log(JSON.stringify({ done: true, rows, counts, seconds: +((performance.now() - t0) / 1000).toFixed(1) }))
closeDB()
