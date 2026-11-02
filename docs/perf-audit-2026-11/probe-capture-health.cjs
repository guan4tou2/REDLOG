#!/usr/bin/env node
// PERF-AUDIT-2026-11 §1.3: the capture-health probes, timed one by one.
//
//   node docs/perf-audit-2026-11/probe-capture-health.cjs <project>/timeline.db
//
// Same SQL as lastEventFor() in src/core/capture-health.ts (both tiers,
// ORDER BY timestamp DESC LIMIT 1). A probe whose source has never produced a
// matching row cannot stop early: it walks the whole agent_type bucket and
// runs json_extract on every row's data.
const Database = require('better-sqlite3')
const db = new Database(process.argv[2], { readonly: true })
const probes = [
  ['terminal (any shell command)', "agent_type = 'shell' AND subtype IN ('command_start','command_end')", []],
  ['mitmproxy (regular)', "agent_type = 'scanner' AND subtype NOT IN ('connection','connection_end') AND COALESCE(json_extract(data,'$.proxy_mode'), 'regular') != 'transparent'", []],
  ['connection monitor', "agent_type = 'scanner' AND subtype IN ('connection','connection_end')", []],
  ['dns', "agent_type = 'dns'", []],
  ['file watcher', "agent_type = 'file_transfer' AND json_extract(data,'$.source') = 'file-watcher'", []],
  ['own shell, no hook installed', "agent_type = 'shell' AND COALESCE(json_extract(data,'$.source'), '') != 'builtin-terminal' AND json_extract(data,'$.shell') IN ('') AND subtype IN ('command_start','command_end')", []],
  ['own shell, zsh installed', "agent_type = 'shell' AND COALESCE(json_extract(data,'$.source'), '') != 'builtin-terminal' AND json_extract(data,'$.shell') IN ('zsh') AND subtype IN ('command_start','command_end')", []],
  ['own shell captured output, zsh', "agent_type = 'shell' AND COALESCE(json_extract(data,'$.source'), '') != 'builtin-terminal' AND json_extract(data,'$.shell') IN ('zsh') AND subtype = 'command_end' AND json_extract(data,'$.output_disposition') = 'captured'", []],
  ['AI agent row, kind never used (codex)', "agent_type = 'agent' AND json_extract(data,'$.agent') = ?", ['codex']],
  ['AI agent row, kind never used (claude-code)', "agent_type = 'agent' AND json_extract(data,'$.agent') = ?", ['claude-code']],
  ['producer heartbeat', "agent_type = 'system' AND subtype = 'producer_heartbeat' AND json_extract(data,'$.producer') = ?", ['pcap']]
]
for (const [label, where, params] of probes) {
  const t = performance.now()
  const a = db.prepare(`SELECT timestamp AS t FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT 1`).get(...params)
  const b = db.prepare(`SELECT timestamp AS t FROM events_logged WHERE ${where} ORDER BY timestamp DESC LIMIT 1`).get(...params)
  console.log(JSON.stringify({ probe: label, ms: Math.round(performance.now() - t), found: !!(a || b) }))
}
