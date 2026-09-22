import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let queryEvents: typeof import('../src/core/db/event-queries').queryEvents
let takeExportSnapshot: typeof import('../src/core/export-plan').takeExportSnapshot

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const queryMod = await import('../src/core/db/event-queries')
  const planMod = await import('../src/core/export-plan')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  queryEvents = queryMod.queryEvents
  takeExportSnapshot = planMod.takeExportSnapshot
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

function rawInsert(
  table: 'events' | 'events_logged',
  ts: number,
  agentType: string,
  data: Record<string, unknown> = {}
): string {
  const db = getDB()
  const id = `ev-${Math.random().toString(36).slice(2, 10)}`
  const dataStr = JSON.stringify({ command: `nmap -sV ${id}`, ...data })
  db.prepare(`
    INSERT INTO ${table} (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at
      ${table === 'events' ? ', hash, prev_hash, signature' : ''})
    VALUES (?, ?, 'test-eng', 'test-sess', 'test-op',
      ?, ?, '', '', '', ?, ?
      ${table === 'events' ? ", 'h', 'p', 's'" : ''})
  `).run(id, ts, agentType, data.subtype ?? null, dataStr, ts)
  return id
}

let tmpDir: string

describeDB('ExportSnapshot', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-snap-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('takeExportSnapshot', () => {
    it('captures max rowid from both tiers', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 3; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      const snap = takeExportSnapshot()
      expect(snap.chainedMaxRowId).toBe(5)
      expect(snap.loggedMaxRowId).toBe(3)
      expect(snap.takenAt).toBeGreaterThan(0)
    })

    it('returns 0 for empty tables', () => {
      const snap = takeExportSnapshot()
      expect(snap.chainedMaxRowId).toBe(0)
      expect(snap.loggedMaxRowId).toBe(0)
    })
  })

  describe('queryEvents with snapshot bound', () => {
    it('excludes events inserted after the snapshot', () => {
      for (let i = 0; i < 10; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 8; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      const snap = takeExportSnapshot()

      // Insert more events AFTER the snapshot
      for (let i = 0; i < 5; i++) rawInsert('events', 3000 + i, 'shell')
      for (let i = 0; i < 3; i++) rawInsert('events_logged', 4000 + i, 'scanner')

      // Without snapshot: sees all 26
      const all = queryEvents({ limit: -1 })
      expect(all).toHaveLength(26)

      // With snapshot: sees only the original 18
      const bounded = queryEvents({ limit: -1, snapshot: snap })
      expect(bounded).toHaveLength(18)
    })

    it('snapshot-bounded query returns the same set as a concurrent unbounded query at snapshot time', () => {
      for (let i = 0; i < 20; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 15; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      const snap = takeExportSnapshot()
      const atSnapshotTime = queryEvents({ limit: -1 })

      // New arrivals
      for (let i = 0; i < 10; i++) rawInsert('events', 5000 + i, 'shell')
      for (let i = 0; i < 7; i++) rawInsert('events_logged', 6000 + i, 'scanner')

      const bounded = queryEvents({ limit: -1, snapshot: snap })
      expect(bounded).toHaveLength(atSnapshotTime.length)
      expect(new Set(bounded.map((e) => e.id))).toEqual(new Set(atSnapshotTime.map((e) => e.id)))
    })

    it('snapshot works with other filters (agentType, since, before)', () => {
      for (let i = 0; i < 10; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 10; i++) rawInsert('events', 2000 + i, 'screenshot')

      const snap = takeExportSnapshot()

      // Insert more after snapshot
      for (let i = 0; i < 5; i++) rawInsert('events', 3000 + i, 'shell')

      const bounded = queryEvents({ limit: -1, snapshot: snap, agentType: 'shell' })
      expect(bounded).toHaveLength(10)
      expect(bounded.every((e) => e.agentType === 'shell')).toBe(true)
    })

    it('snapshot works with tier=chained', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 3; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      const snap = takeExportSnapshot()
      rawInsert('events', 9000, 'shell')

      const bounded = queryEvents({ limit: -1, snapshot: snap, tier: 'chained' })
      expect(bounded).toHaveLength(5)
    })

    it('snapshot works with tier=logged', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 3; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      const snap = takeExportSnapshot()
      rawInsert('events_logged', 9000, 'scanner')

      const bounded = queryEvents({ limit: -1, snapshot: snap, tier: 'logged' })
      expect(bounded).toHaveLength(3)
    })
  })

  describe('preview=execute invariant', () => {
    it('preview snapshot ensures execute sees the same events despite concurrent inserts', () => {
      // Simulate real flow: preview → new events arrive → execute with snapshot
      for (let i = 0; i < 100; i++) rawInsert('events', 1000 + i, 'shell')
      for (let i = 0; i < 50; i++) rawInsert('events_logged', 2000 + i, 'scanner')

      // Step 1: preview takes snapshot + queries
      const snap = takeExportSnapshot()
      const previewEvents = queryEvents({ limit: -1, snapshot: snap })
      expect(previewEvents).toHaveLength(150)

      // Step 2: new events arrive (live capture between preview and confirm)
      for (let i = 0; i < 30; i++) rawInsert('events', 5000 + i, 'shell')
      for (let i = 0; i < 20; i++) rawInsert('events_logged', 6000 + i, 'scanner')

      // Step 3: execute with same snapshot
      const executeEvents = queryEvents({ limit: -1, snapshot: snap })
      expect(executeEvents).toHaveLength(150)
      expect(new Set(executeEvents.map((e) => e.id))).toEqual(
        new Set(previewEvents.map((e) => e.id))
      )

      // Without snapshot: would see 200
      const unbounded = queryEvents({ limit: -1 })
      expect(unbounded).toHaveLength(200)
    })
  })
})
