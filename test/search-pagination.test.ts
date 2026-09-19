import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let searchEventsPage: typeof import('../src/core/db/event-queries').searchEventsPage

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const queryMod = await import('../src/core/db/event-queries')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  searchEventsPage = queryMod.searchEventsPage
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

describeDB('searchEventsPage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-search-page-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('acceptance: 537 matching events, pageSize=100', () => {
    const PAGE_SIZE = 100

    beforeEach(() => {
      for (let i = 0; i < 250; i++) {
        rawInsert('events', 10000 - i, 'shell', { command: `searchterm target-${i}` })
      }
      for (let i = 0; i < 287; i++) {
        rawInsert('events_logged', 10000 - i, 'scanner', {
          subtype: 'http_response', url: `http://searchterm.example/${i}`
        })
      }
    })

    it('paginating through all pages yields exactly 537 unique events', () => {
      const allIds: string[] = []
      let cursor: string | null = null

      for (let safety = 0; safety < 20; safety++) {
        const page = searchEventsPage({ query: 'searchterm', limit: PAGE_SIZE, cursor })
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
        const page = searchEventsPage({ query: 'searchterm', limit: PAGE_SIZE, cursor })
        for (const e of page.items) {
          expect(seen.has(e.id), `duplicate: ${e.id}`).toBe(false)
          seen.add(e.id)
          expect(e.timestamp).toBeLessThanOrEqual(prevTs)
          prevTs = e.timestamp
        }
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
    })

    it('concat(allPages) equals uncapped result set', () => {
      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 20; safety++) {
        const page = searchEventsPage({ query: 'searchterm', limit: PAGE_SIZE, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      const uncapped = searchEventsPage({ query: 'searchterm', limit: 1000 })
      expect(allIds).toHaveLength(uncapped.items.length)
      expect(new Set(allIds)).toEqual(new Set(uncapped.items.map((e) => e.id)))
    })
  })

  describe('combined filters: query + agentType + since/before + cursor', () => {
    beforeEach(() => {
      for (let i = 0; i < 200; i++) {
        rawInsert('events', 5000 + i, 'shell', { command: `findme cmd-${i}` })
      }
      for (let i = 0; i < 150; i++) {
        rawInsert('events_logged', 5000 + i, 'scanner', {
          subtype: 'http_response', url: `http://findme.example/${i}`
        })
      }
      for (let i = 0; i < 50; i++) {
        rawInsert('events', 5000 + i, 'screenshot', { command: `findme screenshot-${i}` })
      }
    })

    it('agentType filter returns only matching type across pages', () => {
      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 20; safety++) {
        const page = searchEventsPage({ query: 'findme', limit: 50, cursor, agentType: 'shell' })
        for (const e of page.items) {
          expect(e.agentType).toBe('shell')
        }
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
      expect(allIds).toHaveLength(200)
    })

    it('since/before narrows time range across pages', () => {
      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 20; safety++) {
        const page = searchEventsPage({
          query: 'findme', limit: 50, cursor,
          since: 5050, before: 5099
        })
        for (const e of page.items) {
          expect(e.timestamp).toBeGreaterThanOrEqual(5050)
          expect(e.timestamp).toBeLessThanOrEqual(5099)
        }
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
      expect(allIds.length).toBeGreaterThan(0)
      expect(new Set(allIds).size).toBe(allIds.length)
    })
  })

  describe('dual-tier with identical timestamps', () => {
    it('cursor correctly pages through dense same-timestamp cross-tier rows', () => {
      for (let i = 0; i < 20; i++) {
        rawInsert('events', 5000, 'shell', { command: `dense-chained-${i}` })
        rawInsert('events_logged', 5000, 'scanner', {
          subtype: 'http_response', url: `http://dense-logged-${i}/`
        })
      }

      const allIds: string[] = []
      let cursor: string | null = null
      for (let safety = 0; safety < 20; safety++) {
        const page = searchEventsPage({ query: 'dense', limit: 5, cursor })
        allIds.push(...page.items.map((e) => e.id))
        if (!page.hasMore) break
        cursor = page.nextCursor
      }

      expect(allIds).toHaveLength(40)
      expect(new Set(allIds).size).toBe(40)
    })
  })

  describe('live-append: new events during pagination do not cause duplicates', () => {
    it('page 2 does not duplicate page 1 after new insert', () => {
      for (let i = 0; i < 10; i++) {
        rawInsert('events', 5000 - i * 10, 'shell', { command: `paginatetest item-${i}` })
      }

      const page1 = searchEventsPage({ query: 'paginatetest', limit: 5 })
      expect(page1.items).toHaveLength(5)
      expect(page1.hasMore).toBe(true)
      const page1Ids = new Set(page1.items.map((e) => e.id))

      rawInsert('events', 9999, 'shell', { command: 'paginatetest late-insert' })

      const page2 = searchEventsPage({ query: 'paginatetest', limit: 5, cursor: page1.nextCursor })
      for (const e of page2.items) {
        expect(page1Ids.has(e.id), `page 2 duplicated ${e.id}`).toBe(false)
      }
    })
  })

  describe('edge cases', () => {
    it('empty query returns empty page', () => {
      rawInsert('events', 5000, 'shell', { command: 'anything' })
      const page = searchEventsPage({ query: '' })
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
    })

    it('no matching results returns empty page', () => {
      rawInsert('events', 5000, 'shell', { command: 'foo' })
      const page = searchEventsPage({ query: 'zzz_nonexistent_zzz' })
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
    })

    it('items are RedLogEvent objects', () => {
      rawInsert('events', 5000, 'shell', { command: 'whoami searchable' })
      const page = searchEventsPage({ query: 'searchable', limit: 10 })
      expect(page.items).toHaveLength(1)
      const e = page.items[0]
      expect(e.agentType).toBe('shell')
      expect(typeof e.timestamp).toBe('number')
      expect(e.tier).toBe('chained')
    })

    it('non-matching events are excluded', () => {
      rawInsert('events', 5000, 'shell', { command: 'findable term' })
      rawInsert('events', 5001, 'shell', { command: 'other stuff' })
      const page = searchEventsPage({ query: 'findable', limit: 10 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0].data.command).toContain('findable')
    })
  })
})
