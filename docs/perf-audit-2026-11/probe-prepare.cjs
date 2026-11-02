#!/usr/bin/env node
// PERF-AUDIT-2026-11 §3.3 (d): native memory held by better-sqlite3 statements
// prepared in a loop that never yields to the event loop.
//
//   node --expose-gc docs/perf-audit-2026-11/probe-prepare.cjs
//
// Phase 1 prepares 20,000 statements per round without yielding; phase 2 does
// the same with a gc() and a setImmediate between rounds. Statements are N-API
// objects whose finalizers run on the event loop, so phase 1 grows without
// bound and phase 2 plateaus.

const Database = require('better-sqlite3')
const mb = () => { const m = process.memoryUsage(); return `rss ${(m.rss / 1048576).toFixed(0)} MiB, heap ${(m.heapUsed / 1048576).toFixed(0)} MiB` }
const db = new Database(':memory:')
db.exec('CREATE TABLE t (a, b)')
const SQL = 'SELECT a, b FROM t WHERE a = ?'

;(async () => {
  console.log('start', mb())
  for (let r = 1; r <= 4; r++) {
    for (let i = 0; i < 20000; i++) db.prepare(SQL)
    console.log(`no yield, round ${r}`, mb())
  }
  if (global.gc) { global.gc(); console.log('after gc()', mb()) }
  for (let r = 1; r <= 4; r++) {
    for (let i = 0; i < 20000; i++) db.prepare(SQL)
    if (global.gc) global.gc()
    await new Promise((res) => setImmediate(res))
    await new Promise((res) => setTimeout(res, 50))
    console.log(`yield each round, round ${r}`, mb())
  }
})()
