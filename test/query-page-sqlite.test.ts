import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  encodeCursor, decodeCursor, buildPerArmCursorWhere,
  toQueryPage, TIER_RANK_CHAINED, TIER_RANK_LOGGED,
  CANONICAL_ORDER, type CursorKey, type QueryPage
} from '../src/core/query-page'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

type RawRow = {
  _row: number
  tier: 'chained' | 'logged'
  tier_rank: number
  timestamp: number
  id: string
}

function rawInsert(
  table: 'events' | 'events_logged',
  ts: number,
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
  `).run(id, ts, agentType, data.subtype ?? null, data.target_id ?? null, JSON.stringify(data), ts)
  return id
}

function buildDualTierSQL(
  limit: number,
  cursor: CursorKey | null,
  extraWhere: string = '',
  extraParams: unknown[] = []
): { sql: string; params: unknown[] } {
  const chainedConds = extraWhere ? [extraWhere] : []
  const loggedConds = extraWhere ? [extraWhere] : []
  const chainedCursorParams: unknown[] = []
  const loggedCursorParams: unknown[] = []

  if (cursor) {
    const chainedCW = buildPerArmCursorWhere(cursor, 'chained')
    chainedConds.push(chainedCW.sql)
    chainedCursorParams.push(...chainedCW.params)

    const loggedCW = buildPerArmCursorWhere(cursor, 'logged')
    loggedConds.push(loggedCW.sql)
    loggedCursorParams.push(...loggedCW.params)
  }

  const chainedWhere = chainedConds.length ? `WHERE ${chainedConds.join(' AND ')}` : ''
  const loggedWhere = loggedConds.length ? `WHERE ${loggedConds.join(' AND ')}` : ''

  const perArmLimit = limit + 1

  const chainedArm = `
    SELECT rowid AS _row, id, timestamp, 'chained' AS tier, ${TIER_RANK_CHAINED}
    FROM events ${chainedWhere}
    ORDER BY timestamp DESC, _row DESC
    LIMIT ?`
  const loggedArm = `
    SELECT rowid AS _row, id, timestamp, 'logged' AS tier, ${TIER_RANK_LOGGED}
    FROM events_logged ${loggedWhere}
    ORDER BY timestamp DESC, _row DESC
    LIMIT ?`

  const sql = `
    SELECT * FROM (
      SELECT * FROM (${chainedArm})
      UNION ALL
      SELECT * FROM (${loggedArm})
    )
    ${CANONICAL_ORDER}
    LIMIT ?`

  const params = [
    ...extraParams, ...chainedCursorParams, perArmLimit,
    ...extraParams, ...loggedCursorParams, perArmLimit,
    limit + 1
  ]
  return { sql, params }
}

function queryPage(
  limit: number,
  cursor: CursorKey | null = null,
  extraWhere: string = '',
  extraParams: unknown[] = []
): QueryPage<RawRow> {
  const db = getDB()
  const { sql, params } = buildDualTierSQL(limit, cursor, extraWhere, extraParams)
  const rows = db.prepare(sql).all(...params) as RawRow[]
  return toQueryPage(rows, limit, (r) => ({
    ts: r.timestamp,
    row: r._row,
    tier: r.tier
  }))
}

function queryAll(limit: number): RawRow[] {
  const db = getDB()
  const sql = `
    SELECT * FROM (
      SELECT * FROM (
        SELECT rowid AS _row, id, timestamp, 'chained' AS tier, ${TIER_RANK_CHAINED}
        FROM events ORDER BY timestamp DESC, _row DESC
      )
      UNION ALL
      SELECT * FROM (
        SELECT rowid AS _row, id, timestamp, 'logged' AS tier, ${TIER_RANK_LOGGED}
        FROM events_logged ORDER BY timestamp DESC, _row DESC
      )
    ) ${CANONICAL_ORDER}`
  return db.prepare(sql).all() as RawRow[]
}

function paginateAll(pageSize: number): RawRow[] {
  const all: RawRow[] = []
  let cursor: CursorKey | null = null
  for (let safety = 0; safety < 200; safety++) {
    const page = queryPage(pageSize, cursor)
    all.push(...page.items)
    if (!page.hasMore || !page.nextCursor) break
    cursor = decodeCursor(page.nextCursor)
    if (!cursor) throw new Error('Failed to decode cursor')
  }
  return all
}

let tmpDir: string

describeDB('EventCursor against real dual-tier SQLite', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cursor-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('basic pagination', () => {
    it('paginates 20 chained-only events with pageSize=7', () => {
      for (let i = 0; i < 20; i++) rawInsert('events', 5000 - i * 10)
      const uncapped = queryAll(20)
      expect(uncapped).toHaveLength(20)

      const paginated = paginateAll(7)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })

    it('paginates 20 logged-only events with pageSize=7', () => {
      for (let i = 0; i < 20; i++) rawInsert('events_logged', 5000 - i * 10)
      const uncapped = queryAll(20)
      const paginated = paginateAll(7)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })

    it('paginates mixed tiers with pageSize=3', () => {
      for (let i = 0; i < 10; i++) rawInsert('events', 5000 - i * 10)
      for (let i = 0; i < 10; i++) rawInsert('events_logged', 5000 - i * 10)
      const uncapped = queryAll(20)
      expect(uncapped).toHaveLength(20)

      const paginated = paginateAll(3)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })
  })

  describe('timestamp collision (the hard case)', () => {
    it('same timestamp, different tiers — tier_rank breaks the tie', () => {
      const chainedId = rawInsert('events', 5000)
      const loggedId = rawInsert('events_logged', 5000)

      const uncapped = queryAll(10)
      expect(uncapped).toHaveLength(2)
      expect(uncapped[0].tier).toBe('chained')
      expect(uncapped[0].id).toBe(chainedId)
      expect(uncapped[1].tier).toBe('logged')
      expect(uncapped[1].id).toBe(loggedId)

      const paginated = paginateAll(1)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })

    it('many events at the same timestamp across both tiers', () => {
      const ids: string[] = []
      for (let i = 0; i < 8; i++) ids.push(rawInsert('events', 5000))
      for (let i = 0; i < 8; i++) ids.push(rawInsert('events_logged', 5000))

      const uncapped = queryAll(20)
      expect(uncapped).toHaveLength(16)

      const paginated = paginateAll(3)
      expect(paginated).toHaveLength(16)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })

    it('identical (timestamp, rowid) across tiers — tier_rank is the only discriminator', () => {
      const chainedId = rawInsert('events', 5000)
      const loggedId = rawInsert('events_logged', 5000)

      const db = getDB()
      const chainedRow = (db.prepare('SELECT rowid FROM events WHERE id = ?').get(chainedId) as { rowid: number }).rowid
      const loggedRow = (db.prepare('SELECT rowid FROM events_logged WHERE id = ?').get(loggedId) as { rowid: number }).rowid

      if (chainedRow === loggedRow) {
        const paginated = paginateAll(1)
        expect(paginated).toHaveLength(2)
        expect(paginated[0].tier).toBe('chained')
        expect(paginated[1].tier).toBe('logged')
      }
    })
  })

  describe('pagination invariants on real DB data', () => {
    const DATASET_CONFIGS = [
      { name: 'sparse timestamps', chainedCount: 15, loggedCount: 15, tsGen: (i: number) => 10000 - i * 100 },
      { name: 'dense timestamps (5 distinct values)', chainedCount: 12, loggedCount: 12, tsGen: (i: number) => 5000 - (i % 5) * 10 },
      { name: 'all same timestamp', chainedCount: 10, loggedCount: 10, tsGen: () => 5000 },
    ]

    for (const cfg of DATASET_CONFIGS) {
      describe(cfg.name, () => {
        let uncapped: RawRow[]

        beforeEach(() => {
          for (let i = 0; i < cfg.chainedCount; i++) rawInsert('events', cfg.tsGen(i))
          for (let i = 0; i < cfg.loggedCount; i++) rawInsert('events_logged', cfg.tsGen(i + cfg.chainedCount))
          uncapped = queryAll(999)
          expect(uncapped).toHaveLength(cfg.chainedCount + cfg.loggedCount)
        })

        for (const pageSize of [1, 3, 7, 50]) {
          it(`concat(pages) = uncapped [pageSize=${pageSize}]`, () => {
            const paginated = paginateAll(pageSize)
            expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
          })

          it(`pages are disjoint [pageSize=${pageSize}]`, () => {
            const seen = new Set<string>()
            let cursor: CursorKey | null = null
            for (let safety = 0; safety < 200; safety++) {
              const page = queryPage(pageSize, cursor)
              for (const item of page.items) {
                expect(seen.has(item.id), `duplicate: ${item.id}`).toBe(false)
                seen.add(item.id)
              }
              if (!page.hasMore || !page.nextCursor) break
              cursor = decodeCursor(page.nextCursor)!
            }
          })

          it(`each page is in canonical order [pageSize=${pageSize}]`, () => {
            let cursor: CursorKey | null = null
            for (let safety = 0; safety < 200; safety++) {
              const page = queryPage(pageSize, cursor)
              for (let i = 1; i < page.items.length; i++) {
                const prev = page.items[i - 1], curr = page.items[i]
                const ok =
                  prev.timestamp > curr.timestamp ||
                  (prev.timestamp === curr.timestamp && prev._row > curr._row) ||
                  (prev.timestamp === curr.timestamp && prev._row === curr._row && prev.tier_rank > curr.tier_rank)
                expect(ok, `order violation at index ${i}: (${prev.timestamp},${prev._row},${prev.tier_rank}) vs (${curr.timestamp},${curr._row},${curr.tier_rank})`).toBe(true)
              }
              if (!page.hasMore || !page.nextCursor) break
              cursor = decodeCursor(page.nextCursor)!
            }
          })
        }
      })
    }
  })

  describe('edge cases', () => {
    it('empty database returns hasMore=false', () => {
      const page = queryPage(10)
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeNull()
    })

    it('exactly pageSize items returns hasMore=false', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 5000 - i * 10)
      const page = queryPage(5)
      expect(page.items).toHaveLength(5)
      expect(page.hasMore).toBe(false)
    })

    it('pageSize+1 items returns hasMore=true with pageSize items', () => {
      for (let i = 0; i < 6; i++) rawInsert('events', 5000 - i * 10)
      const page = queryPage(5)
      expect(page.items).toHaveLength(5)
      expect(page.hasMore).toBe(true)
    })

    it('pageSize=1 walks every row individually', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 5000 - i)
      for (let i = 0; i < 5; i++) rawInsert('events_logged', 5000 - i)
      const uncapped = queryAll(20)
      const paginated = paginateAll(1)
      expect(paginated.map(r => r.id)).toEqual(uncapped.map(r => r.id))
    })

    it('cursor past all data returns empty page', () => {
      for (let i = 0; i < 5; i++) rawInsert('events', 5000)
      const past = encodeCursor({ ts: 0, row: 1, tier: 'logged' })
      const page = queryPage(10, decodeCursor(past))
      expect(page.items).toHaveLength(0)
      expect(page.hasMore).toBe(false)
    })
  })

  describe('buildPerArmCursorWhere', () => {
    it('buildPerArmCursorWhere uses rowid (not alias) and works inside each arm', () => {
      rawInsert('events', 5000)
      rawInsert('events', 4000)

      const db = getDB()
      const cursor: CursorKey = { ts: 9999, row: 9999, tier: 'chained' }
      const cw = buildPerArmCursorWhere(cursor, 'chained')

      const sql = `
        SELECT rowid AS _row, id, timestamp, 'chained' AS tier, ${TIER_RANK_CHAINED}
        FROM events
        WHERE ${cw.sql}
        ORDER BY timestamp DESC, rowid DESC LIMIT 10`

      const rows = db.prepare(sql).all(...cw.params) as RawRow[]
      expect(rows).toHaveLength(2)
    })

    it('per-arm logged includes row at (cursor.ts, cursor.row) when cursor is chained', () => {
      const loggedId = rawInsert('events_logged', 5000)

      const db = getDB()
      const loggedRow = (db.prepare('SELECT rowid FROM events_logged WHERE id = ?').get(loggedId) as { rowid: number }).rowid
      const cursor: CursorKey = { ts: 5000, row: loggedRow, tier: 'chained' }
      const cw = buildPerArmCursorWhere(cursor, 'logged')

      const sql = `
        SELECT rowid AS _row, id, timestamp FROM events_logged
        WHERE ${cw.sql} ORDER BY timestamp DESC, rowid DESC`
      const rows = db.prepare(sql).all(...cw.params) as Array<{ id: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(loggedId)
    })

    it('per-arm logged excludes row at (cursor.ts, cursor.row) when cursor is logged', () => {
      const loggedId = rawInsert('events_logged', 5000)

      const db = getDB()
      const loggedRow = (db.prepare('SELECT rowid FROM events_logged WHERE id = ?').get(loggedId) as { rowid: number }).rowid
      const cursor: CursorKey = { ts: 5000, row: loggedRow, tier: 'logged' }
      const cw = buildPerArmCursorWhere(cursor, 'logged')

      const sql = `
        SELECT rowid AS _row, id, timestamp FROM events_logged
        WHERE ${cw.sql} ORDER BY timestamp DESC, rowid DESC`
      const rows = db.prepare(sql).all(...cw.params) as Array<{ id: string }>
      expect(rows).toHaveLength(0)
    })
  })
})
