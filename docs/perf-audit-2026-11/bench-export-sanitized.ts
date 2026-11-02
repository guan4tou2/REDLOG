// Export redaction cost with a sanitized_events lookup per event — PERF-AUDIT-2026-11 §4.
//
//   node docs/perf-audit-2026-11/run.mjs bench-export-sanitized.ts -- [events] [reps]
//
// Seeds `events` shell rows (10% with a sanitized_events row) in a throwaway
// project, then runs the two export passes that redact every event
// (redactEventsForExport, eventsToNdjson) and reports the median wall time per
// pass. The lookup under test is getSanitizedFields; run it on each side of a
// change to compare.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, getDB, closeDB } from '../../src/core/db/index'
import { insertEvent, queryEvents } from '../../src/core/db/events'
import { redactEventsForExport } from '../../src/core/redact-export'
import { eventsToNdjson } from '../../src/core/ndjson-export'

const [nArg = '20000', repsArg = '3'] = process.argv.slice(2)
const N = Number(nArg)
const REPS = Number(repsArg)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bench-export-'))
initDB(dir)
const OP = { operatorId: 'op-1', engagementId: 'eng-1' }
const db = getDB()
const ids: string[] = []
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const ev = insertEvent('shell', { subtype: 'command_end', command: `cmd ${i}`, output: `out ${i} `.repeat(8) }, OP)
    if (ev) ids.push(ev.id)
  }
})()
const ins = db.prepare('INSERT INTO sanitized_events (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id) VALUES (?, ?, ?, ?, ?, ?)')
db.transaction(() => { for (let i = 0; i < ids.length; i += 10) ins.run(ids[i], 'output', '[masked]', 'sha', Date.now(), 'x') })()

const events = queryEvents({ limit: -1 })
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const pass = (label: string, fn: () => unknown): number => {
  const runs: number[] = []
  for (let r = 0; r < REPS; r++) { const t0 = performance.now(); fn(); runs.push(performance.now() - t0) }
  const m = median(runs)
  console.log(JSON.stringify({ pass: label, events: events.length, medianMs: +m.toFixed(1), usPerEvent: +((m * 1000) / events.length).toFixed(2) }))
  return m
}
const a = pass('redactEventsForExport', () => redactEventsForExport(events, {}))
const b = pass('eventsToNdjson', () => eventsToNdjson(events, {}))
console.log(JSON.stringify({ twoPassesMs: +(a + b).toFixed(1) }))
closeDB()
fs.rmSync(dir, { recursive: true, force: true })
