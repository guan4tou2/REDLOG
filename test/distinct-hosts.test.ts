import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// §10 ⌘K host search: distinct data.host across both tiers, busiest first.
// Companion to target-aggregate.test.ts — same SQL-over-JSON shape (#65).

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let distinctHosts: typeof import('../src/core/db/events').distinctHosts

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  insertEventRaw = eventsMod.insertEvent; distinctHosts = eventsMod.distinctHosts
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const insertEvent: typeof import('../src/core/db/events').insertEvent = (a, d, o) =>
  insertEventRaw(a, d, { operatorId: 'test-op', ...o })
const describeDB = dbAvailable ? describe : describe.skip
let tmpDir: string

describeDB('distinctHosts', () => {
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-host-')); initDB(tmpDir) })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('groups distinct hosts with a hit count, busiest first', () => {
    // scanner:http_response → logged tier; also a chained shell hit with a host.
    insertEvent('scanner', { subtype: 'http_response', host: 'busy.example', flow_id: 'a' })
    insertEvent('scanner', { subtype: 'http_response', host: 'busy.example', flow_id: 'b' })
    insertEvent('scanner', { subtype: 'http_response', host: 'busy.example', flow_id: 'c' })
    insertEvent('dns', { subtype: 'dns_query', host: 'rare.example' })
    const rows = distinctHosts()
    expect(rows.map((r) => r.host)).toEqual(['busy.example', 'rare.example'])
    expect(rows[0].count).toBe(3)
    expect(rows[1].count).toBe(1)
    expect(rows[0].lastSeen).toBeGreaterThan(0)
  })

  it('excludes events with no host', () => {
    insertEvent('shell', { command: 'whoami' })       // no host
    insertEvent('scanner', { subtype: 'http_response', host: '', flow_id: 'x' }) // empty
    insertEvent('scanner', { subtype: 'http_response', host: 'real.example', flow_id: 'y' })
    expect(distinctHosts().map((r) => r.host)).toEqual(['real.example'])
  })

  it('respects the limit', () => {
    for (let i = 0; i < 10; i++) insertEvent('scanner', { subtype: 'http_response', host: `h${i}.example`, flow_id: `f${i}` })
    expect(distinctHosts(4)).toHaveLength(4)
  })
})
