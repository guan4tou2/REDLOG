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

describeDB('queryEventsPage', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-event-page-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('walks a filtered dataset exactly once with opaque cursors', () => {
    for (let i = 0; i < 9; i++) {
      insertEvent('agent', { subtype: 'assistant_message', content: `agent-${i}` }, { operatorId: 'op' })
      insertEvent('shell', { subtype: 'command_end', command: `shell-${i}`, exit_code: 0 }, { operatorId: 'op' })
    }

    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = queryEventsPage({ agentType: 'agent', limit: 4, cursor })
      ids.push(...page.items.map((event) => event.id))
      cursor = page.nextCursor
      if (!page.hasMore) break
    } while (true)

    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
  })
})
