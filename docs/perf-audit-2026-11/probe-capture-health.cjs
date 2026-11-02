#!/usr/bin/env node
// PERF-AUDIT-2026-11 §1.3: the capture-health probes, timed one by one.
//
//   node docs/perf-audit-2026-11/probe-capture-health.cjs <project>/timeline.db [shell,...]
//
// Same SQL as newestEvent() in src/core/capture-health.ts: each probe is a
// conjunction of EQUALITIES, run against both tiers (ORDER BY timestamp DESC
// LIMIT 1), and a source with several subtypes or shell names is several
// probes whose newest row wins. Before the rewrite a source that had never
// produced a row walked its whole agent_type bucket, running json_extract on
// every row's data; 198k rows took 5-6 s per read.
//
// The database must have been opened by a build that has the probe indexes
// (initDB creates them). The optional second argument is the list of installed
// shell hooks, default none. Set PLAN=1 to print the query plan of each probe.
const Database = require('better-sqlite3')
const db = new Database(process.argv[2], { readonly: true })
const shells = process.argv[3] ? process.argv[3].split(',') : []
const shellNames = shells.length ? shells : ['']
const CMD = ['command_start', 'command_end']
const OWN = "agent_type = 'shell' AND COALESCE(json_extract(data,'$.source'), '') != 'builtin-terminal'"

// [label, [[where, params], ...]]
const probes = [
  ['terminal (any shell command)', CMD.map((s) => ["agent_type = 'shell' AND subtype = ?", [s]])],
  ['mitmproxy (regular)', [["agent_type = 'scanner' AND subtype NOT IN ('connection','connection_end') AND COALESCE(json_extract(data,'$.proxy_mode'), 'regular') != 'transparent'", []]]],
  ['connection monitor', ['connection', 'connection_end'].map((s) => ["agent_type = 'scanner' AND subtype = ?", [s]])],
  ['dns', [["agent_type = 'dns'", []]]],
  ['file watcher', [["agent_type = 'file_transfer' AND json_extract(data,'$.source') = 'file-watcher'", []]]],
  [`own shell (${shellNames.join(',') || 'none'})`, shellNames.flatMap((n) => CMD.map((s) => [`${OWN} AND json_extract(data,'$.shell') = ? AND subtype = ?`, [n, s]]))],
  [`own shell captured output (${shellNames.join(',') || 'none'})`, shellNames.map((n) => [`${OWN} AND json_extract(data,'$.shell') = ? AND subtype = 'command_end' AND json_extract(data,'$.output_disposition') = 'captured'`, [n]])],
  ['AI agent row, kind never used (codex)', [["agent_type = 'agent' AND json_extract(data,'$.agent') = ?", ['codex']]]],
  ['AI agent row, kind never used (claude-code)', [["agent_type = 'agent' AND json_extract(data,'$.agent') = ?", ['claude-code']]]],
  ['plugin: transparent proxy', ['http_request_start', 'http_response'].map((s) => ["agent_type = 'scanner' AND json_extract(data,'$.proxy_mode') = 'transparent' AND subtype = ?", [s]])],
  ['plugin: pcap', ['packet_flow', 'pcap_segment'].map((s) => ['agent_type = ? AND subtype = ?', ['scanner', s]])],
  ['plugin: c2', ['c2_checkin', 'c2_task'].map((s) => ['agent_type = ? AND subtype = ?', ['scanner', s]])],
  ['producer heartbeat', [["agent_type = 'system' AND subtype = 'producer_heartbeat' AND json_extract(data,'$.producer') = ?", ['pcap']]]]
]
let total = 0
for (const [label, alts] of probes) {
  const t = performance.now()
  let found = false
  for (const [where, params] of alts) {
    for (const table of ['events', 'events_logged']) {
      const sql = `SELECT timestamp AS t FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT 1`
      if (process.env.PLAN) console.log(`  ${table}: ` + db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' ; '))
      if (db.prepare(sql).get(...params)) found = true
    }
  }
  const ms = performance.now() - t
  total += ms
  console.log(JSON.stringify({ probe: label, ms: Math.round(ms), found }))
}
console.log(JSON.stringify({ totalMs: Math.round(total) }))
