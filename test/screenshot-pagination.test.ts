import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let queryScreenshotPage: typeof import('../src/core/db/event-queries').queryScreenshotPage

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const queryMod = await import('../src/core/db/event-queries')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  queryScreenshotPage = queryMod.queryScreenshotPage
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

function rawInsert(
  table: 'events' | 'events_logged',
  ts: number,
  trigger: string,
  extra: Record<string, unknown> = {}
): string {
  const db = getDB()
  const id = `ss-${Math.random().toString(36).slice(2, 10)}`
  const data = JSON.stringify({
    trigger,
    filename: `${id}.jpg`,
    filePath: `/tmp/screenshots/${id}.jpg`,
    sha256: `fake-${id}`,
    ...extra
  })
  db.prepare(`
    INSERT INTO ${table} (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at
      ${table === 'events' ? ', hash, prev_hash, signature' : ''})
    VALUES (?, ?, 'test-eng', 'test-sess', 'test-op',
      'screenshot', NULL, '', '', '', ?, ?
      ${table === 'events' ? ", 'h', 'p', 's'" : ''})
  `).run(id, ts, data, ts)
  return id
}

let tmpDir: string

describeDB('queryScreenshotPage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ss-page-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('acceptance: 537 screenshots, pageSize=100', () => {
    const PAGE_SIZE = 100

    // One transaction: row-at-a-time autocommit fsyncs every insert, which on
    // a loaded Windows runner outlasts the 10s hook timeout.
    beforeEach(() => getDB().transaction(() => {
      for (let i = 0; i < 537; i++) {
        const trigger = i % 3 === 0 ? 'periodic' : i % 3 === 1 ? 'manual' : 'command'
        rawInsert('events', 10000 - i, trigger)
      }
    })())

    it('paginating through all pages yields exactly 537 unique screenshots', () => {
      const allIds: string[] = []
      let cursor: string | null = null

      for (let safety = 0; safety < 20; safety++) {
        const page = queryScreenshotPage({ limit: PAGE_SIZE, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull()
          break
        }
        expect(page.nextCursor).not.toBeNull()
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(537)
      expect(new Set(allIds).size).toBe(537)
    })

    it('pages are disjoint and in canonical order', () => {
      const seen = new Set<string>()
      let cursor: string | null = null
      let prevTs = Infinity

      for (let safety = 0; safety < 20; safety++) {
        const page = queryScreenshotPage({ limit: PAGE_SIZE, cursor })
        for (const e of page.items) {
          expect(seen.has(e.id), `duplicate: ${e.id}`).toBe(false)
          seen.add(e.id)
          expect(e.timestamp).toBeLessThanOrEqual(prevTs)
          prevTs = e.timestamp
          expect(e.agentType).toBe('screenshot')
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
    })

    it('does not return non-screenshot events', () => {
      const db = getDB()
      db.prepare(`
        INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
          agent_type, subtype, hostname, source_ip, target_id, data, created_at,
          hash, prev_hash, signature)
        VALUES ('shell-1', 5000, 'test-eng', 'test-sess', 'test-op',
          'shell', NULL, '', '', '', '{"command":"whoami"}', 5000,
          'h', 'p', 's')
      `).run()

      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 20; safety++) {
        const page = queryScreenshotPage({ limit: PAGE_SIZE, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(537)
      expect(allIds).not.toContain('shell-1')
    })
  })

  describe('trigger filter pushes into SQL WHERE', () => {
    // One transaction: row-at-a-time autocommit fsyncs every insert, which on
    // a loaded Windows runner outlasts the 10s hook timeout.
    beforeEach(() => getDB().transaction(() => {
      for (let i = 0; i < 450; i++) rawInsert('events', 10000 - i, 'periodic')
      for (let i = 0; i < 87; i++) rawInsert('events', 10000 - i, 'manual')
    })())

    it('trigger=manual returns exactly 87 results across pages', () => {
      const allIds: string[] = []
      let cursor: string | null = null

      for (let safety = 0; safety < 20; safety++) {
        const page = queryScreenshotPage({ limit: 100, cursor, trigger: 'manual' })
        for (const e of page.items) {
          expect(e.data.trigger).toBe('manual')
        }
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(87)
      expect(new Set(allIds).size).toBe(87)
    })

    it('trigger=null returns all 537', () => {
      const allIds: string[] = []
      let cursor: string | null = null

      for (let safety = 0; safety < 20; safety++) {
        const page = queryScreenshotPage({ limit: 100, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(537)
    })

    it('first page with trigger filter does not silently cap', () => {
      // If filter were post-LIMIT, first page of 100 all-screenshots would
      // contain only ~16 manual shots. This test asserts we get up to limit.
      const page = queryScreenshotPage({ limit: 50, trigger: 'manual' })
      expect(page.items).toHaveLength(50)
      expect(page.hasMore).toBe(true)
      for (const e of page.items) {
        expect(e.data.trigger).toBe('manual')
      }
    })
  })

  describe('live-append: new screenshots during pagination', () => {
    it('page 2 does not duplicate page 1 after new insert', () => {
      for (let i = 0; i < 10; i++) rawInsert('events', 5000 - i * 10, 'periodic')

      const page1 = queryScreenshotPage({ limit: 5 })
      expect(page1.items).toHaveLength(5)
      expect(page1.hasMore).toBe(true)
      const page1Ids = new Set(page1.items.map((e) => e.id))

      rawInsert('events', 9999, 'manual')

      const page2 = queryScreenshotPage({ limit: 5, cursor: page1.nextCursor })
      for (const e of page2.items) {
        expect(page1Ids.has(e.id), `page 2 duplicated ${e.id}`).toBe(false)
      }
    })
  })

  describe('dual-tier query', () => {
    it('returns screenshots from both chained and logged tiers', () => {
      rawInsert('events', 5000, 'manual')
      rawInsert('events_logged', 4999, 'api')

      const page = queryScreenshotPage({ limit: 10 })
      expect(page.items).toHaveLength(2)
      const tiers = page.items.map((e) => e.tier)
      expect(tiers).toContain('chained')
      expect(tiers).toContain('logged')
    })

    it('interleaves tiers by timestamp', () => {
      rawInsert('events', 5000, 'periodic')
      rawInsert('events_logged', 5001, 'api')
      rawInsert('events', 4999, 'manual')

      const page = queryScreenshotPage({ limit: 10 })
      expect(page.items).toHaveLength(3)
      expect(page.items[0].timestamp).toBe(5001)
      expect(page.items[0].tier).toBe('logged')
      expect(page.items[1].timestamp).toBe(5000)
      expect(page.items[1].tier).toBe('chained')
      expect(page.items[2].timestamp).toBe(4999)
    })
  })

  describe('edge cases', () => {
    it('no screenshots returns empty page', () => {
      const page = queryScreenshotPage({})
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeNull()
    })

    it('items are RedLogEvent objects', () => {
      rawInsert('events', 5000, 'manual')
      const page = queryScreenshotPage({ limit: 10 })
      expect(page.items).toHaveLength(1)
      const e = page.items[0]
      expect(e.agentType).toBe('screenshot')
      expect(e.data.trigger).toBe('manual')
      expect(typeof e.timestamp).toBe('number')
    })

    it('deletion audit events are not included', () => {
      rawInsert('events', 5000, 'manual')
      const db = getDB()
      db.prepare(`
        INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
          agent_type, subtype, hostname, source_ip, target_id, data, created_at,
          hash, prev_hash, signature)
        VALUES ('del-1', 5001, 'test-eng', 'test-sess', 'test-op',
          'system', 'screenshot_deleted', '', '', '', '{"subtype":"screenshot_deleted"}', 5001,
          'h', 'p', 's')
      `).run()

      const page = queryScreenshotPage({ limit: 10 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0].agentType).toBe('screenshot')
    })
  })
})
