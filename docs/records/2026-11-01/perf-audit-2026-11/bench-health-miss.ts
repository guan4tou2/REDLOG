// Synthetic rows isolate the indexed missing-source lookup; this does not benchmark app startup.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, getDB, closeDB } from '../../../../src/core/db/index'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-health-recheck-'))
initDB(dir)
const db = getDB()
const insert = db.prepare("INSERT INTO events(id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,hash,created_at) VALUES (?,?,'bench','bench','bench','agent','tool_result','host',?,'fixture',?)")
db.transaction(() => {
  for (let i = 0; i < 200000; i++) insert.run(String(i), i, JSON.stringify({agent:'claude-code',output:'benchmark data '+i}), i)
})()
const sql = "SELECT timestamp FROM events WHERE agent_type = 'agent' AND json_extract(data,'$.agent') = ? ORDER BY timestamp DESC LIMIT 1"
function measure(query: string) {
  const times: number[] = []
  for (let iteration = 0; iteration < 10; iteration++) {
    const start = performance.now()
    db.prepare(query).get('codex')
    times.push(performance.now() - start)
  }
  return { firstMs: times[0], medianMs: times.slice().sort((a, b) => a - b)[5], maxMs: Math.max(...times) }
}
console.log(JSON.stringify({
  platform: process.platform, arch: process.arch, node: process.version, rows: 200000,
  fixture: 'synthetic agent bucket with no codex rows; unsigned SQL fixtures',
  query: sql, plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all('codex'),
  indexed: measure(sql), forcedScan: measure(sql.replace('FROM events WHERE', 'FROM events NOT INDEXED WHERE'))
}))
closeDB()
fs.rmSync(dir, { recursive: true })
