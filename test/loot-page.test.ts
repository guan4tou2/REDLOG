import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let queryEventsPage: typeof import('../src/core/db/events').queryEventsPage
let available = false

try {
  const db = await import('../src/core/db')
  const events = await import('../src/core/db/events')
  initDB = db.initDB
  closeDB = db.closeDB
  insertEvent = events.insertEvent
  queryEventsPage = events.queryEventsPage
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

describeDB('loot event pages', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-page-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('walks every loot event exactly once without unrelated events consuming the limit', () => {
    for (let i = 0; i < 7; i++) {
      insertEvent('loot', { matches: [{ type: 'flag', confidence: 'high', preview: `loot-${i}` }] }, { operatorId: 'op' })
      insertEvent('shell', { subtype: 'command_end', command: `shell-${i}` }, { operatorId: 'op' })
    }

    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = queryEventsPage({ agentType: 'loot', limit: 3, cursor })
      ids.push(...page.items.map((event) => event.id))
      cursor = page.nextCursor
      if (!page.hasMore) break
    } while (true)

    expect(ids).toHaveLength(7)
    expect(new Set(ids).size).toBe(7)
  })
})
