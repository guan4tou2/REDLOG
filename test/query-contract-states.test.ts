// Spec 017 T006 — RED.
//
// Three query outcomes that a recorder must not collapse into one another.
//
//   unparsable   the query was never asked
//   failed       the query was asked and the store did not answer
//   no match     the query was asked, answered, and nothing matched
//
// Only the third licenses "this did not happen". A recorder that renders a
// failure as an empty list invites the opposite of the correct conclusion, and
// it does so most often exactly when the store is under stress.
//
// There is deliberately no not-yet-indexed case here. Search has one because
// it searches terminal recordings and `castIndexStatus` reports a backfill
// backlog; the Transcript searches stored event content and has no equivalent
// pending signal. Its real limit is coverage, not freshness — command output
// the hook never captured inline lives in a recording and no term can reach it
// — and that is disclosed in the view (T017), not represented as a state here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery } from '../src/core/query/contract'
import type { ParsedQuery } from '../src/core/query/contract'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let insertEvent: typeof import('../src/core/db/event-write').insertEvent
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let available = false

try {
  const db = await import('../src/core/db')
  const write = await import('../src/core/db/event-write')
  const queries = await import('../src/core/db/event-queries')
  initDB = db.initDB
  closeDB = db.closeDB
  insertEvent = write.insertEvent
  executeEventQuery = queries.executeEventQuery
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

function textQuery(text: string): ParsedQuery {
  return { conditions: [], text, tokens: [{ raw: text, read: 'text' }] }
}

describe('unparsable is decided before the store is touched (T006)', () => {
  it('a half-typed condition never becomes a query', () => {
    const outcome = parseQuery('session:')
    expect(outcome.ok).toBe(false)
  })

  it('a parsable query yields something executable', () => {
    const outcome = parseQuery('session:S1 timeout')
    expect(outcome.ok).toBe(true)
  })
})

describeDB('failure and absence are different answers (T006)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-query-states-'))
    initDB(dir)
    insertEvent('agent', { subtype: 'assistant_message', session_id: 'S1', full: 'connection refused' }, { operatorId: 'op' })
  })
  afterEach(() => {
    try { closeDB() } catch { /* a test may have closed it already */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports no match as an answered, empty page', () => {
    const result = executeEventQuery({ parsed: textQuery('nonexistentterm') })
    expect(result.items).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('reports a match as a non-empty page, so the empty case means something', () => {
    const result = executeEventQuery({ parsed: textQuery('refused') })
    expect(result.items.length).toBeGreaterThan(0)
  })

  it('raises rather than returning an empty page when the store cannot answer', () => {
    // Answer the query first, so the throw below is attributable to the closed
    // store rather than to the query path simply being unavailable — otherwise
    // an unimplemented or removed path would satisfy this test by accident.
    expect(executeEventQuery({ parsed: textQuery('refused') }).items.length).toBeGreaterThan(0)
    closeDB()
    expect(() => executeEventQuery({ parsed: textQuery('refused') })).toThrow()
  })
})
