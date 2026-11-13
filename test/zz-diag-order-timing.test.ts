// TEMPORARY diagnostic, never merged: where do the 10 s of
// event-display-order's 300-row test go on Windows?
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { queryEvents } from '../src/core/db/event-queries'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-diag-')); initDB(dir) })
afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

const T = 1_700_000_000_000
function add(table: 'events' | 'events_logged', id: string, ts: number): void {
  getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${table === 'events' ? ',hash,prev_hash' : ''})
    VALUES (?,?,'eng','binding','operator','marker','','host',NULL,NULL,?,?${table === 'events' ? ", 'fixture-hash', NULL" : ''})`).run(id, ts, JSON.stringify({ title: id }), ts)
}
const ms = (t0: bigint): number => Number((process.hrtime.bigint() - t0) / 1_000_000n)
const out: string[] = []
const note = (s: string): void => { out.push(s); console.log(`[DIAG] ${s}`) }

describe('diag: 300 single-row inserts', () => {
  it('times each phase', () => {
    note(`platform=${process.platform} REAL=${process.env.REDLOG_TEST_REAL_SYNCHRONOUS ?? '-'} patched=${String(Boolean((Object.getPrototypeOf(getDB()) as Record<symbol, unknown>)[Symbol.for('redlog.test.synchronousRelaxed')]))}`)
    note(`before first write: synchronous=${String(getDB().pragma('synchronous', { simple: true }))} journal=${String(getDB().pragma('journal_mode', { simple: true }))}`)

    let t = process.hrtime.bigint()
    for (let i = 0; i < 150; i++) add('events_logged', `l${i}`, T + (i % 4))
    note(`150 autocommit inserts into events_logged: ${ms(t)}ms`)
    note(`after writes: synchronous=${String(getDB().pragma('synchronous', { simple: true }))}`)

    t = process.hrtime.bigint()
    for (let i = 0; i < 150; i++) add('events', `c${i}`, T + (i % 4))
    note(`150 autocommit inserts into events: ${ms(t)}ms`)

    t = process.hrtime.bigint()
    getDB().transaction(() => { for (let i = 0; i < 150; i++) add('events', `x${i}`, T + (i % 4)) })()
    note(`150 inserts into events in ONE transaction: ${ms(t)}ms`)

    const triggers = getDB().prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'").all() as { name: string; tbl_name: string }[]
    note(`triggers: ${triggers.map(x => `${x.tbl_name}.${x.name}`).join(', ') || 'none'}`)

    t = process.hrtime.bigint()
    const rows = queryEvents({ order: 'oldest', limit: 1000 })
    note(`queryEvents(limit 1000) -> ${rows.length} rows: ${ms(t)}ms`)

    t = process.hrtime.bigint()
    getDB().pragma('wal_checkpoint(PASSIVE)')
    note(`wal_checkpoint(PASSIVE): ${ms(t)}ms`)

    // Same loop with the pragma forced each way on this connection.
    for (const level of ['OFF', 'NORMAL', 'FULL'] as const) {
      process.env.REDLOG_TEST_REAL_SYNCHRONOUS = '1'
      getDB().pragma(`synchronous = ${level}`)
      delete process.env.REDLOG_TEST_REAL_SYNCHRONOUS
      t = process.hrtime.bigint()
      for (let i = 0; i < 100; i++) add('events_logged', `${level}${i}`, T)
      note(`100 autocommit inserts at synchronous=${level} (reads ${String(getDB().pragma('synchronous', { simple: true }))}): ${ms(t)}ms`)
    }
    expect(out.length).toBeGreaterThan(5)
  })
})
