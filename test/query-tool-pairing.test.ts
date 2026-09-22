// Spec 017 T005 — RED.
//
// Completing a tool pair whose halves fall on different pages.
//
// The cost test is the one worth writing carefully. The agent bucket pages at
// 800 records, so a page can end with hundreds of calls whose results sit on
// the next page. Fetching each counterpart on its own turns one scroll into
// hundreds of round trips against the store, which is why FR-009 asks for the
// page as a whole rather than one lookup per record. Asserting a fixed number
// would bake in an implementation; asserting that the number does not change
// between five keys and fifty is the property that actually matters.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let getReadonlyDB: typeof import('../src/core/db').getReadonlyDB
let insertEvent: typeof import('../src/core/db/event-write').insertEvent
let fetchToolCounterparts: typeof import('../src/core/db/event-queries').fetchToolCounterparts
let available = false

try {
  const db = await import('../src/core/db')
  const write = await import('../src/core/db/event-write')
  const queries = await import('../src/core/db/event-queries')
  initDB = db.initDB
  closeDB = db.closeDB
  getReadonlyDB = db.getReadonlyDB
  insertEvent = write.insertEvent
  fetchToolCounterparts = queries.fetchToolCounterparts
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

function seed(data: Record<string, unknown>): string {
  const event = insertEvent('agent', data, { operatorId: 'op' })
  if (!event) throw new Error('insertEvent returned null; capture is paused')
  return event.id
}

function call(sessionId: string, toolUseId: string): string {
  return seed({ subtype: 'tool_call', session_id: sessionId, tool_use_id: toolUseId, tool_name: 'bash' })
}

function result(sessionId: string, toolUseId: string): string {
  return seed({ subtype: 'tool_result', session_id: sessionId, tool_use_id: toolUseId, output: 'ok' })
}

/** Counts statements prepared while `run` executes, on the live connection. */
function countPrepares(run: () => void): number {
  const db = getReadonlyDB() as unknown as { prepare: (sql: string) => unknown }
  const original = db.prepare.bind(db)
  let prepared = 0
  db.prepare = (sql: string): unknown => { prepared += 1; return original(sql) }
  try {
    run()
  } finally {
    db.prepare = original
  }
  return prepared
}

describeDB('tool pair completion (T005)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tool-pairing-'))
    initDB(dir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the half that was not on the page', () => {
    const theCall = call('S1', 'T7')
    result('S1', 'T7')
    const found = fetchToolCounterparts([{ sessionId: 'S1', toolUseId: 'T7' }])
    expect(found.map((e) => e.id)).toContain(theCall)
  })

  it('keys on the session as well as the tool-use id', () => {
    call('S1', 'T7')
    const otherCall = call('S2', 'T7')
    const found = fetchToolCounterparts([{ sessionId: 'S2', toolUseId: 'T7' }])
    expect(found.map((e) => e.id)).toContain(otherCall)
    expect(found.every((e) => (e.data as { session_id?: string }).session_id === 'S2')).toBe(true)
  })

  it('returns nothing for a key whose counterpart does not exist', () => {
    // The caller marks this pair incomplete rather than showing one half as a
    // whole exchange; an empty return is the input to that, not an error.
    call('S1', 'T-unanswered')
    const found = fetchToolCounterparts([{ sessionId: 'S1', toolUseId: 'T-absent' }])
    expect(found).toEqual([])
  })

  it('serves many keys at once', () => {
    const wanted: string[] = []
    for (let i = 0; i < 50; i++) wanted.push(call('S1', `T${i}`))
    const keys = wanted.map((_, i) => ({ sessionId: 'S1', toolUseId: `T${i}` }))
    const found = fetchToolCounterparts(keys)
    expect(found.map((e) => e.id).sort()).toEqual([...wanted].sort())
  })

  it('does not issue more queries for more keys', () => {
    for (let i = 0; i < 50; i++) call('S1', `T${i}`)
    const keysFor = (n: number): Array<{ sessionId: string; toolUseId: string }> =>
      Array.from({ length: n }, (_, i) => ({ sessionId: 'S1', toolUseId: `T${i}` }))

    const few = countPrepares(() => { fetchToolCounterparts(keysFor(5)) })
    const many = countPrepares(() => { fetchToolCounterparts(keysFor(50)) })

    expect(few).toBeGreaterThan(0)
    expect(many).toBe(few)
  })

  it('accepts an empty key list without touching the store', () => {
    expect(countPrepares(() => { expect(fetchToolCounterparts([])).toEqual([]) })).toBe(0)
  })
})
