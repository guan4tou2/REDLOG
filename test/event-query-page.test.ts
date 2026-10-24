import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery } from '../src/core/query/contract'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let queryEventsPage: typeof import('../src/core/db/events').queryEventsPage
let executeEventQuery: typeof import('../src/core/db/events').executeEventQuery
let getDB: typeof import('../src/core/db').getDB
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let available = false

try {
  const db = await import('../src/core/db')
  const events = await import('../src/core/db/events')
  initDB = db.initDB
  closeDB = db.closeDB
  insertEvent = events.insertEvent
  queryEventsPage = events.queryEventsPage
  executeEventQuery = events.executeEventQuery
  getDB = db.getDB
  closeHttpBodyIndex = (await import('../src/core/http-body-index')).closeHttpBodyIndex
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
    // A text query opens the body index too; Windows will not delete it open.
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const find = (text: string): string[] => {
    const parsed = parseQuery(text)
    if (!parsed.ok) throw new Error('Invalid test query')
    return executeEventQuery({ parsed: parsed.parsed, limit: 100 }).items.map(e => e.id)
  }

  it.each(['tool_result', 'thinking'])('searches decoded multiline %s text without inventing escaped words', subtype => {
    const event = insertEvent('agent', { subtype,
      output: 'first line\nAFTER_NEWLINE\r\nAFTER_CRLF\tAFTER_TAB',
      tool_input: { paths: ['C:\\tools\\nmap'], nested: { note: 'nested text\nNESTED_LINE' } }
    }, { operatorId: 'op' })!
    for (const word of ['AFTER_NEWLINE', 'AFTER_CRLF', 'AFTER_TAB', 'NESTED_LINE', 'C:\\tools\\nmap']) expect(find(word)).toContain(event.id)
    expect(find('nAFTER_NEWLINE')).not.toContain(event.id)
    expect(find('tnested')).not.toContain(event.id)
    expect(find('tool_input')).toContain(event.id)
    const db = getDB()
    const table = subtype === 'thinking' ? 'events_logged' : 'events'
    const before = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(event.id)
    closeDB(); initDB(dir)
    expect(getDB().prepare('SELECT total_changes() AS writes').get()).toEqual({ writes: 0 })
    expect(find('AFTER_NEWLINE')).toContain(event.id)
    expect(getDB().prepare(`SELECT data FROM ${table} WHERE id = ?`).get(event.id)).toEqual(before)
    for (const fts of ['events_fts', 'events_logged_fts']) getDB().exec(`INSERT INTO ${fts}(${fts}, rank) VALUES ('integrity-check', 1)`)
    if (subtype === 'thinking') {
      getDB().prepare('DELETE FROM events_logged WHERE id = ?').run(event.id)
      expect(find('AFTER_NEWLINE')).not.toContain(event.id)
      getDB().exec("INSERT INTO events_logged_fts(events_logged_fts, rank) VALUES ('integrity-check', 1)")
    }
  })

  it('rebuilds an existing raw JSON search index without changing evidence', () => {
    const event = insertEvent('agent', { subtype: 'assistant_message', full: 'first\nPREVIOUSLY_UNSEARCHABLE' }, { operatorId: 'op' })!
    const db = getDB()
    const evidence = db.prepare('SELECT data, hash, prev_hash FROM events WHERE id = ?').get(event.id)
    db.exec(`DROP TRIGGER events_fts_ai;
      DROP TABLE events_fts;
      CREATE VIRTUAL TABLE events_fts USING fts5(data, target_id, agent_type, content=events, content_rowid=rowid);
      INSERT INTO events_fts(events_fts) VALUES ('rebuild');`)
    closeDB(); initDB(dir)
    expect(find('PREVIOUSLY_UNSEARCHABLE')).toContain(event.id)
    expect(getDB().prepare('SELECT data, hash, prev_hash FROM events WHERE id = ?').get(event.id)).toEqual(evidence)
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
