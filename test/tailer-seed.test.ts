import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.11.5: the tailer's parent-map seed is built once per project, not once
// per session.
//
// registerSession used to run its own query filtered by
// json_extract(data,'$.session_id') — which no index can serve, so each ran a
// full scan of the `agent` bucket. Every session RedLog has ever seen
// re-registers when the project opens. Measured on a real 131,774-event
// engagement: 1,075 sessions × 167 ms = 180 s of blocked main process, which
// is what "opening this project makes everything stutter" was.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let insertEvent: typeof import('../src/core/db/events').insertEvent

let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  const e = await import('../src/core/db/events')
  initDB = d.initDB; closeDB = d.closeDB; getDB = d.getDB; insertEvent = e.insertEvent
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const describeDB = dbAvailable ? describe : describe.skip
let dir: string

// Mirrors buildSeedIndex in tailer-host: one pass, bucketed by agent+session.
const buildIndex = (): Map<string, Map<string, string>> => {
  const idx = new Map<string, Map<string, string>>()
  const rows = getDB().prepare(
    `SELECT id,
            json_extract(data, '$.session_id')      AS sid,
            json_extract(data, '$.agent')           AS agent,
            json_extract(data, '$.transcript_uuid') AS uuid
       FROM events
      WHERE agent_type = 'agent'
        AND json_extract(data, '$.transcript_uuid') IS NOT NULL`
  ).all() as Array<{ id: string; sid: string | null; agent: string | null; uuid: string }>
  for (const r of rows) {
    if (!r.sid || !r.agent) continue
    const key = `${r.agent}:${r.sid}`
    let m = idx.get(key)
    if (!m) { m = new Map(); idx.set(key, m) }
    m.set(r.uuid, r.id)
  }
  return idx
}

// The old shape: one query per session.
const perSession = (sid: string, agent: string): Array<{ id: string; uuid: string }> =>
  getDB().prepare(
    `SELECT id, json_extract(data, '$.transcript_uuid') AS uuid
       FROM events
      WHERE agent_type = 'agent'
        AND json_extract(data, '$.session_id') = ?
        AND json_extract(data, '$.agent') = ?
        AND json_extract(data, '$.transcript_uuid') IS NOT NULL`
  ).all(sid, agent) as Array<{ id: string; uuid: string }>

describeDB('tailer seed index', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-seed-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const seed = (sessions: number, turnsEach: number): void => {
    getDB().transaction(() => {
      for (let s = 0; s < sessions; s++) {
        for (let t = 0; t < turnsEach; t++) {
          insertEvent('agent', {
            subtype: 'assistant_message', agent: 'claude-code',
            session_id: `s-${s}`, transcript_uuid: `u-${s}-${t}`, full: 'x'.repeat(200)
          }, { engagementId: 'e', operatorId: 'op' })
        }
      }
    })()
  }

  it('gives each session exactly the rows the per-session query would', () => {
    seed(12, 5)
    const idx = buildIndex()
    for (let s = 0; s < 12; s++) {
      const expected = perSession(`s-${s}`, 'claude-code')
      const got = idx.get(`claude-code:s-${s}`)!
      expect(got.size, `session s-${s}`).toBe(expected.length)
      for (const row of expected) expect(got.get(row.uuid)).toBe(row.id)
    }
  })

  it('returns nothing for a session with no history', () => {
    seed(3, 2)
    expect(buildIndex().get('claude-code:never-seen')).toBeUndefined()
  })

  it('keys on agent as well as session, so two agents never cross-seed', () => {
    insertEvent('agent', { subtype: 'assistant_message', agent: 'claude-code', session_id: 'shared', transcript_uuid: 'u1' }, { engagementId: 'e', operatorId: 'op' })
    insertEvent('agent', { subtype: 'assistant_message', agent: 'codex', session_id: 'shared', transcript_uuid: 'u2' }, { engagementId: 'e', operatorId: 'op' })
    const idx = buildIndex()
    expect([...(idx.get('claude-code:shared') ?? new Map()).keys()]).toEqual(['u1'])
    expect([...(idx.get('codex:shared') ?? new Map()).keys()]).toEqual(['u2'])
  })

  it('costs one scan for many sessions, not one per session', () => {
    // The property that matters. With N sessions the old shape ran N full
    // scans of the agent bucket; the index runs one. Compared as a ratio so
    // the test is not a wall-clock threshold on CI hardware.
    seed(60, 8)
    const t0 = process.hrtime.bigint()
    buildIndex()
    const single = Number(process.hrtime.bigint() - t0) / 1e6

    const t1 = process.hrtime.bigint()
    for (let s = 0; s < 60; s++) perSession(`s-${s}`, 'claude-code')
    const perSessionTotal = Number(process.hrtime.bigint() - t1) / 1e6

    expect(
      perSessionTotal / Math.max(single, 0.01),
      `one pass ${single.toFixed(1)}ms vs ${perSessionTotal.toFixed(1)}ms across 60 sessions`
    ).toBeGreaterThan(3)
  })
})
