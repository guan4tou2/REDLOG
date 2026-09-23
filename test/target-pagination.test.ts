import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let queryTargetEventsPage: typeof import('../src/core/db/event-queries').queryTargetEventsPage
let aggregateTargets: typeof import('../src/core/db/event-aggregates').aggregateTargets

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const queryMod = await import('../src/core/db/event-queries')
  const aggMod = await import('../src/core/db/event-aggregates')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  queryTargetEventsPage = queryMod.queryTargetEventsPage
  aggregateTargets = aggMod.aggregateTargets
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

function rawInsert(
  table: 'events' | 'events_logged',
  ts: number,
  targetId: string,
  data: Record<string, unknown> = {}
): string {
  const db = getDB()
  const id = `test-${Math.random().toString(36).slice(2, 10)}`
  const agentType = (data.agent_type as string) ?? 'shell'
  db.prepare(`
    INSERT INTO ${table} (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at
      ${table === 'events' ? ', hash, prev_hash, signature' : ''})
    VALUES (?, ?, 'test-eng', 'test-sess', 'test-op',
      ?, ?, '', '', ?, ?, ?
      ${table === 'events' ? ", 'h', 'p', 's'" : ''})
  `).run(id, ts, agentType, data.subtype ?? null, targetId, JSON.stringify(data), ts)
  return id
}

let tmpDir: string

describeDB('queryTargetEventsPage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-target-page-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('acceptance: 873 events (430 chained + 443 logged), pageSize=200', () => {
    const TARGET = '10.0.0.42'
    const CHAINED = 430
    const LOGGED = 443
    const TOTAL = CHAINED + LOGGED
    const PAGE_SIZE = 200

    // One transaction: row-at-a-time autocommit fsyncs every insert, which on
    // a loaded Windows runner outlasts the 10s hook timeout.
    beforeEach(() => getDB().transaction(() => {
      for (let i = 0; i < CHAINED; i++) {
        rawInsert('events', 10000 - i, TARGET, { command: `cmd-c-${i}` })
      }
      for (let i = 0; i < LOGGED; i++) {
        rawInsert('events_logged', 10000 - i, TARGET, {
          agent_type: 'scanner', subtype: 'http_response', url: `http://${TARGET}/l-${i}`
        })
      }
    })())

    it('aggregate eventCount matches total inserted', () => {
      const agg = aggregateTargets()
      const entry = agg.find((a) => a.target === TARGET)
      expect(entry).toBeDefined()
      expect(entry!.eventCount).toBe(TOTAL)
    })

    it('paginating through all pages yields exactly TOTAL unique events', () => {
      const allIds: string[] = []
      let cursor: string | null = null
      let pageCount = 0

      for (let safety = 0; safety < 50; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: PAGE_SIZE, cursor })
        allIds.push(...page.items.map((e) => e.id))
        pageCount++

        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull()
          break
        }
        expect(page.nextCursor).not.toBeNull()
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(TOTAL)
      expect(new Set(allIds).size).toBe(TOTAL)
      expect(pageCount).toBe(Math.ceil(TOTAL / PAGE_SIZE) + (TOTAL % PAGE_SIZE === 0 ? 0 : 0))
    })

    it('concat(allPages).length === aggregate eventCount', () => {
      const agg = aggregateTargets()
      const entry = agg.find((a) => a.target === TARGET)!

      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 50; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: PAGE_SIZE, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      expect(allIds.length).toBe(entry.eventCount)
    })

    it('pages are disjoint', () => {
      const seen = new Set<string>()
      let cursor: string | null = null
      for (let safety = 0; safety < 50; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: PAGE_SIZE, cursor })
        for (const e of page.items) {
          expect(seen.has(e.id), `duplicate event: ${e.id}`).toBe(false)
          seen.add(e.id)
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
    })

    it('all pages are in canonical order (timestamp DESC)', () => {
      let cursor: string | null = null
      let prevTs = Infinity
      for (let safety = 0; safety < 50; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: PAGE_SIZE, cursor })
        for (const e of page.items) {
          expect(e.timestamp).toBeLessThanOrEqual(prevTs)
          prevTs = e.timestamp
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
    })

    it('does not return events from other targets', () => {
      rawInsert('events', 5000, '10.0.0.99', { command: 'other-target' })
      rawInsert('events_logged', 5000, '10.0.0.99', { agent_type: 'scanner', url: 'http://10.0.0.99/' })

      let cursor: string | null = null
      for (let safety = 0; safety < 50; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: PAGE_SIZE, cursor })
        for (const e of page.items) {
          expect(e.targetId).toBe(TARGET)
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
    })
  })

  describe('live-append: new events during pagination do not cause duplicates', () => {
    const TARGET = '10.0.0.50'

    it('page 2 does not duplicate page 1 after new insert', () => {
      for (let i = 0; i < 10; i++) {
        rawInsert('events', 5000 - i * 10, TARGET)
      }

      const page1 = queryTargetEventsPage({ targetId: TARGET, limit: 5 })
      expect(page1.items).toHaveLength(5)
      expect(page1.hasMore).toBe(true)
      const page1Ids = new Set(page1.items.map((e) => e.id))

      rawInsert('events', 9999, TARGET, { command: 'late-insert' })
      rawInsert('events_logged', 9998, TARGET, { agent_type: 'scanner', url: 'http://late/' })

      const page2 = queryTargetEventsPage({ targetId: TARGET, limit: 5, cursor: page1.nextCursor })
      for (const e of page2.items) {
        expect(page1Ids.has(e.id), `page 2 duplicated ${e.id} from page 1`).toBe(false)
      }

      const allIds = [...page1.items.map((e) => e.id), ...page2.items.map((e) => e.id)]
      expect(new Set(allIds).size).toBe(allIds.length)
    })

    it('newly inserted event with older timestamp is still reachable on later pages', () => {
      for (let i = 0; i < 6; i++) {
        rawInsert('events', 5000 - i * 10, TARGET)
      }

      const page1 = queryTargetEventsPage({ targetId: TARGET, limit: 3 })
      expect(page1.hasMore).toBe(true)

      const lateId = rawInsert('events', 4920, TARGET, { command: 'backdated-insert' })

      let found = false
      let cursor = page1.nextCursor
      for (let safety = 0; safety < 20; safety++) {
        const page = queryTargetEventsPage({ targetId: TARGET, limit: 3, cursor })
        if (page.items.some((e) => e.id === lateId)) found = true
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
      expect(found).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('empty target returns hasMore=false', () => {
      const page = queryTargetEventsPage({ targetId: 'nonexistent' })
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeNull()
    })

    it('items are RedLogEvent objects (not raw rows)', () => {
      rawInsert('events', 5000, '10.0.0.1', { command: 'whoami' })
      const page = queryTargetEventsPage({ targetId: '10.0.0.1' })
      expect(page.items).toHaveLength(1)
      const e = page.items[0]
      expect(e.id).toBeDefined()
      expect(e.agentType).toBe('shell')
      expect(e.data.command).toBe('whoami')
      expect(e.tier).toBe('chained')
      expect(typeof e.timestamp).toBe('number')
    })

    it('mixed tiers for same target are properly interleaved', () => {
      rawInsert('events', 5000, '10.0.0.1')
      rawInsert('events_logged', 5000, '10.0.0.1', { agent_type: 'scanner' })
      rawInsert('events', 4000, '10.0.0.1')
      rawInsert('events_logged', 4000, '10.0.0.1', { agent_type: 'scanner' })

      const page = queryTargetEventsPage({ targetId: '10.0.0.1', limit: 10 })
      expect(page.items).toHaveLength(4)
      expect(page.items[0].timestamp).toBe(5000)
      expect(page.items[1].timestamp).toBe(5000)
      expect(page.items[2].timestamp).toBe(4000)
      expect(page.items[3].timestamp).toBe(4000)
    })
  })
})
